const NodeHelper = require("node_helper");
const Log = require("logger");

const WL_URL = "https://www.wienerlinien.at/ogd_realtime/monitor";
const WL_TRAFFIC_URL = "https://www.wienerlinien.at/ogd_realtime/trafficInfoList?name=stoerunglang&name=stoerungkurz";
const REQUEST_TIMEOUT = 15 * 1000;
const MIN_UPDATE_INTERVAL = 30 * 1000;
const DEFAULT_UPDATE_INTERVAL = 60 * 1000;
const DEFAULT_KEEP_LAST_DATA = 5 * 60 * 1000;

// Rejects if the promise does not settle within ms (hafas-client has no timeout of its own)
function withTimeout (promise, ms) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`timeout after ${ms / 1000}s`)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

module.exports = NodeHelper.create({
	start () {
		Log.log(`Starting node helper for: ${this.name}`);
		this.timers = {};
		this.runs = {};
		this.lastGood = {};	// last successful result per instance and station
		this.lastDisruptions = {};	// last successful disruption list per instance
	},

	socketNotificationReceived (notification, payload) {
		if (notification !== "VT_START") return;
		const {id, config} = payload;

		// Guard against intervals that would hammer the APIs (0, negative, typos)
		const requested = Number(config.updateInterval);
		const interval = Number.isFinite(requested) ? Math.max(MIN_UPDATE_INTERVAL, requested) : DEFAULT_UPDATE_INTERVAL;
		if (interval !== requested) {
			Log.warn(`[MMM-ViennaTransit] updateInterval ${config.updateInterval} is invalid or too low, using ${interval / 1000}s (minimum ${MIN_UPDATE_INTERVAL / 1000}s)`);
		}

		// A new start (e.g. browser reload) supersedes any running loop for this instance
		clearTimeout(this.timers[id]);
		const run = Symbol(id);
		this.runs[id] = run;

		// Schedule the next update only after the current one finished, so updates never overlap
		const loop = async () => {
			await this.update(id, config, run);
			if (this.runs[id] === run) {
				this.timers[id] = setTimeout(loop, interval);
			}
		};
		loop();
	},

	async update (id, config, run) {
		const requestedKeep = Number(config.keepLastDataFor);
		const keepFor = Number.isFinite(requestedKeep) && requestedKeep >= 0 ? requestedKeep : DEFAULT_KEEP_LAST_DATA;
		this.lastGood[id] ??= {};

		const stations = await Promise.all((config.stations ?? []).map(async (station, index) => {
			const name = station?.name ?? `Station #${index + 1}`;
			// Per station: hide departures sooner than this (e.g. walking time to that stop)
			const minMinutes = Math.max(0, Number(station?.minMinutes) || 0);
			try {
				let lines;
				if (station?.oebb) {
					lines = await this.fetchOebb(station, config);
				} else if ([].concat(station?.rbl ?? []).length > 0) {
					lines = await this.fetchWienerLinien(station);
				} else {
					throw new Error('config needs either rbl: ["<RBL number>", ...] (Wiener Linien) or oebb: "<station ID>" (ÖBB)');
				}
				this.lastGood[id][JSON.stringify(station)] = {lines, time: Date.now()};
				return {name, minMinutes, lines};
			} catch (error) {
				// On failure keep showing the last good departures for up to keepLastDataFor;
				// the browser counts them down, and error: true still shows the warning sign
				const last = this.lastGood[id][JSON.stringify(station)];
				const age = last ? Date.now() - last.time : Infinity;
				const stale = age <= keepFor;
				Log.error(`[MMM-ViennaTransit] ${name}: ${error.message}${stale ? ` (showing data from ${Math.round(age / 1000)}s ago)` : ""}`);
				return {name, minMinutes, lines: stale ? last.lines : [], error: true};
			}
		}));
		const disruptions = config.showDisruptions === false ? [] : await this.disruptionsFor(id, config, stations);
		// Drop results from a loop that was superseded while it was fetching
		if (this.runs[id] !== run) return;
		this.sendSocketNotification("VT_DATA", {id, stations, disruptions, updated: Date.now()});
	},

	// Current Wiener Linien disruptions for the configured lines, or else the U-Bahn lines at the configured stations
	async disruptionsFor (id, config, stations) {
		const configured = [].concat(config.disruptionLines ?? []).map((l) => String(l).toUpperCase());
		const wanted = new Set(configured.length > 0
			? configured
			: stations.flatMap((s) => s.lines).filter((l) => l.type === "ptMetro").map((l) => l.name.toUpperCase()));
		if (wanted.size === 0) return [];
		try {
			this.lastDisruptions[id] = await this.fetchDisruptions();
		} catch (error) {
			// Keep the previous list rather than hiding a disruption because of one failed request
			Log.error(`[MMM-ViennaTransit] disruptions: ${error.message}`);
		}
		return (this.lastDisruptions[id] ?? [])
			.map((d) => ({...d, lines: d.lines.filter((l) => wanted.has(l.toUpperCase()))}))
			.filter((d) => d.lines.length > 0);
	},

	async fetchDisruptions () {
		const response = await fetch(WL_TRAFFIC_URL, {signal: AbortSignal.timeout(REQUEST_TIMEOUT)});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const json = await response.json();
		const now = Date.now();
		const seen = new Set();
		const disruptions = [];
		for (const info of json.data?.trafficInfos ?? []) {
			// Skip planned ones that have not started yet and ones already over
			const start = Date.parse(info?.time?.start);
			const end = Date.parse(info?.time?.end);
			if (start > now || end < now) continue;
			const lines = [...new Set(info?.relatedLines ?? [])].map(String);
			const text = (info?.title ?? "").replace(/\s+/g, " ").trim();
			const key = `${lines.join(",")}|${text}`;
			if (lines.length === 0 || !text || seen.has(key)) continue;
			seen.add(key);
			disruptions.push({
				lines,
				// "U3: Verspätungen" -> "Verspätungen", the line is shown as a badge
				title: text.replace(/^[A-Z]?\d+[A-Z]?(\s*,\s*[A-Z]?\d+[A-Z]?)*:\s*/i, ""),
				description: (info.description ?? "").replace(/\s+/g, " ").trim()
			});
		}
		return disruptions;
	},

	// Wiener Linien realtime API: U-Bahn, tram, bus (RBL numbers)
	async fetchWienerLinien (station) {
		const query = [].concat(station.rbl).map((rbl) => `rbl=${encodeURIComponent(rbl)}`).join("&");
		const response = await fetch(`${WL_URL}?${query}`, {signal: AbortSignal.timeout(REQUEST_TIMEOUT)});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const json = await response.json();

		const lines = [];
		for (const monitor of json.data?.monitors ?? []) {
			// Skip malformed entries instead of failing the whole station
			for (const line of monitor.lines ?? []) {
				if (!line?.name) continue;
				lines.push({
					name: line.name,
					type: line.type,
					towards: line.towards ?? "",
					// Absolute times, so the browser can count down between fetches
					times: (line.departures?.departure ?? [])
						.map((d) => Date.parse(d?.departureTime?.timeReal ?? d?.departureTime?.timePlanned))
						.filter((t) => Number.isFinite(t))
				});
			}
		}
		return lines;
	},

	// ÖBB HAFAS: S-Bahn and regional trains
	async fetchOebb (station, config) {
		if (!this.hafas) {
			const {createClient} = await import("hafas-client");
			const {profile} = await import("hafas-client/p/oebb/index.js");
			this.hafas = createClient(profile, "MMM-ViennaTransit");
		}
		const products = Object.fromEntries(["nationalExpress", "national", "interregional", "regional", "suburban", "bus", "ferry", "subway", "tram", "onCall"]
			.map((p) => [p, (station.products ?? ["suburban", "regional"]).includes(p)]));
		const {departures} = await withTimeout(this.hafas.departures(station.oebb, {
			duration: config.oebbWindow,
			products,
			remarks: false
		}), REQUEST_TIMEOUT);

		const grouped = new Map();
		for (const dep of departures) {
			const time = Date.parse(dep.when);
			if (dep.cancelled || !Number.isFinite(time)) continue;
			const name = (dep.line?.name ?? "?").replace(/\s*\(.*\)$/, "").replace(/\s+/g, "");
			const towards = dep.direction ?? "";	// hafas-client returns null when ÖBB sends no destination
			const key = `${name}|${towards}`;
			if (!grouped.has(key)) grouped.set(key, {name, type: "ptTrainS", towards, times: []});
			grouped.get(key).times.push(time);
		}
		return [...grouped.values()];
	}
});
