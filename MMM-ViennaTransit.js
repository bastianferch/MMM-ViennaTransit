/* MMM-ViennaTransit
 * All configured Vienna stations in one card: Wiener Linien (U-Bahn, tram, bus) and ÖBB (S-Bahn).
 */
Module.register("MMM-ViennaTransit", {
	defaults: {
		stations: [],	// [{name, rbl: ["4902"], minMinutes: 3}] or [{name, oebb: "8101433", products: ["suburban"], minMinutes: 5}]
		departuresPerLine: 3,	// how many upcoming times per line/direction
		maxLinesPerStation: 6,
		hideEmptyStations: false,
		shortenDestination: 22,
		updateInterval: 60 * 1000,	// minimum 30 s
		oebbWindow: 90,	// minutes to look ahead on ÖBB
		keepLastDataFor: 5 * 60 * 1000,	// after a failed fetch, keep showing the last good departures this long (ms, 0 = off)
		showDisruptions: true,	// Wiener Linien disruption messages at the top of the card
		disruptionLines: [],	// lines to show disruptions for, e.g. ["U3", "U6"]; [] = the U-Bahn lines at your stations
		pulseLeaveNow: true	// pulse a departure when it is exactly minMinutes away, i.e. the last minute to leave
	},

	getStyles () {
		return ["font-awesome.css", "MMM-ViennaTransit.css"];
	},

	start () {
		this.data_ = null;
		this.sendSocketNotification("VT_START", {id: this.identifier, config: this.config});
		// Count down locally between fetches
		setInterval(() => {
			if (this.data_) this.updateDom();
		}, 20 * 1000);
	},

	hasErrors () {
		return Boolean(this.data_?.stations.some((station) => station.error));
	},

	// Red warning sign at the top right when a station could not be loaded
	getHeader () {
		const header = this.data.header ?? "";
		if (!this.hasErrors()) return header;
		return `${header}<i class="fas fa-triangle-exclamation vt-warning"></i>`;
	},

	// Whole minutes until departure, rounded down so a train is never later than shown
	minutesUntil (time, now) {
		return Math.floor((time - now) / 60000);
	},

	socketNotificationReceived (notification, payload) {
		if (notification === "VT_DATA" && payload.id === this.identifier) {
			this.data_ = payload;
			this.updateDom(500);
		}
	},

	lineClass (line) {
		if (line.type === "ptMetro") return `vt-u vt-${line.name.toLowerCase()}`;
		if (line.type === "ptTrainS") return "vt-s";
		if (line.type === "ptTram") return "vt-tram";
		if (line.type && line.type.startsWith("ptBus")) return "vt-bus";
		return "vt-other";
	},

	shorten (value) {
		const text = value == null ? "" : String(value);
		const max = this.config.shortenDestination;
		return max && text.length > max ? `${text.slice(0, max - 1)}…` : text;
	},

	getDom () {
		const wrapper = document.createElement("div");
		wrapper.className = "vt small";
		if (!this.data_) {
			wrapper.innerHTML = this.translate("LOADING");
			wrapper.classList.add("dimmed");
			return wrapper;
		}

		if (this.config.showDisruptions) {
			for (const disruption of this.data_.disruptions ?? []) {
				wrapper.appendChild(this.disruptionDom(disruption));
			}
		}

		const now = Date.now();
		for (const station of this.data_.stations) {
			const lines = station.lines
				.map((l) => ({
					...l,
					minutes: l.times
						.map((t) => this.minutesUntil(t, now))
						.filter((m) => m >= (station.minMinutes ?? 0))
						.sort((a, b) => a - b)
						.slice(0, this.config.departuresPerLine)
				}))
				.filter((l) => l.minutes.length > 0)
				.sort((a, b) => a.minutes[0] - b.minutes[0])
				.slice(0, this.config.maxLinesPerStation);
			if (lines.length === 0 && this.config.hideEmptyStations) continue;

			const title = document.createElement("div");
			title.className = "vt-station bright";
			title.textContent = station.name;
			wrapper.appendChild(title);

			const table = document.createElement("table");
			table.className = "vt-table";
			if (lines.length === 0) {
				const row = table.insertRow();
				const cell = row.insertCell();
				cell.className = "dimmed";
				cell.textContent = station.error ? "Keine Daten" : "Keine Abfahrten";
			}
			for (const line of lines) {
				const row = table.insertRow();
				const badgeCell = row.insertCell();
				const badge = document.createElement("span");
				badge.className = `vt-badge ${this.lineClass(line)}`;
				badge.textContent = line.name;
				badgeCell.appendChild(badge);

				const dest = row.insertCell();
				dest.className = "vt-dest";
				dest.textContent = this.shorten(line.towards);

				const times = row.insertCell();
				times.className = "vt-times bright";
				const leaveNow = this.config.pulseLeaveNow && line.minutes[0] === (station.minMinutes ?? 0);
				times.innerHTML = line.minutes
					.map((m, i) => (i === 0 ? `<span class="vt-next${leaveNow ? " vt-leave" : ""}">${m === 0 ? "jetzt" : m}</span>` : m))
					.join(" · ");
			}
			wrapper.appendChild(table);
		}
		return wrapper;
	},

	disruptionDom (disruption) {
		const box = document.createElement("div");
		box.className = "vt-disruption";

		const head = document.createElement("div");
		head.className = "vt-disruption-head bright";
		const icon = document.createElement("i");
		icon.className = "fas fa-triangle-exclamation vt-disruption-icon";
		head.appendChild(icon);
		for (const name of disruption.lines) {
			const badge = document.createElement("span");
			badge.className = `vt-badge ${this.lineClass({name, type: /^U\d$/i.test(name) ? "ptMetro" : ""})}`;
			badge.textContent = name;
			head.appendChild(badge);
		}
		head.appendChild(document.createTextNode(disruption.title));
		box.appendChild(head);

		if (disruption.description && disruption.description !== disruption.title) {
			const text = document.createElement("div");
			text.className = "vt-disruption-text xsmall dimmed";
			text.textContent = disruption.description;
			box.appendChild(text);
		}
		return box;
	}
});
