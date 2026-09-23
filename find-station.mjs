// Find ÖBB station IDs for the `oebb` option.
//   node find-station.mjs "Wien Meidling"      search by name
//   node find-station.mjs 48.1947 16.3863      stations within 500 m of a coordinate
import {createClient} from "hafas-client";
import {profile} from "hafas-client/p/oebb/index.js";

const client = createClient(profile, "MMM-ViennaTransit");
const args = process.argv.slice(2);

if (args.length === 0) {
	console.log('Usage: node find-station.mjs "<station name>"  |  node find-station.mjs <latitude> <longitude>');
	process.exit(1);
}

const byCoordinates = args.length === 2 && args.every((a) => Number.isFinite(Number(a)));
const results = byCoordinates
	? await client.nearby({type: "location", latitude: Number(args[0]), longitude: Number(args[1])}, {distance: 500, results: 15, poi: false})
	: await client.locations(args.join(" "), {results: 10, poi: false, addresses: false});

for (const station of results) {
	const products = Object.entries(station.products ?? {}).filter(([, on]) => on).map(([name]) => name).join(", ");
	const distance = station.distance === undefined ? "" : ` (${station.distance} m)`;
	console.log(`${station.id.padEnd(9)} ${station.name}${distance}  [${products}]`);
}
