#!/usr/bin/env node
// Small admin CLI for the venue/event registry. Uses the same backend selection as the
// pipeline (D1 when D1_DATABASE_ID + CLOUDFLARE_API_TOKEN are set, else the local SQLite file).
//
//   node scripts/registry.js stats
//   node scripts/registry.js venues [search]        list venues (optionally filtered)
//   node scripts/registry.js venue <id>             show one venue with its aliases
//   node scripts/registry.js merge <fromId> <intoId> retire a duplicate; stars on it redirect
//   node scripts/registry.js rename <id> <new name> change a venue's display name
//   node scripts/registry.js alias <id> <raw name>  teach the registry another spelling
import "dotenv/config";
import { createExecutorFromEnv } from "../lib/registry/executors.js";
import { Registry } from "../lib/registry/store.js";

const [command, ...args] = process.argv.slice(2);

function printVenue(venue) {
	const merged = venue.mergedInto ? `  -> merged into ${venue.mergedInto}` : "";
	const where = [venue.region, venue.nearestMrt].filter(Boolean).join(", ") || "not located";
	console.log(`${venue.id.padEnd(48)} ${venue.name}  [${where}]  last seen ${venue.lastSeen}${merged}`);
}

async function main() {
	const { executor } = await createExecutorFromEnv();
	const registry = await Registry.open({ executor });
	console.error(`Registry: ${executor.describe()}`);

	switch (command) {
		case "stats": {
			const active = registry.activeVenues();
			console.log({
				venues: active.length,
				mergedVenues: registry.venues.size - active.length,
				unlocatedVenues: active.filter((venue) => venue.lat === null).length,
				aliases: registry.aliases.size,
				recentEvents: registry.events.size,
			});
			break;
		}
		case "venues": {
			const query = (args.join(" ") || "").toLowerCase();
			[...registry.venues.values()]
				.filter((venue) => !query || venue.name.toLowerCase().includes(query) || venue.id.includes(query))
				.sort((a, b) => a.name.localeCompare(b.name))
				.forEach(printVenue);
			break;
		}
		case "venue": {
			const venue = registry.venues.get(args[0]);
			if (!venue) throw new Error(`No venue ${args[0]}`);
			printVenue(venue);
			for (const [alias, venueId] of registry.aliases) {
				if (venueId === venue.id) console.log(`  alias: ${alias}`);
			}
			break;
		}
		case "merge": {
			const [fromId, intoId] = args;
			registry.mergeVenue(fromId, intoId);
			await registry.commit();
			console.log(`Merged ${fromId} into ${registry.canonicalVenueId(intoId)}`);
			break;
		}
		case "rename": {
			const [id, ...nameParts] = args;
			const venue = registry.venues.get(id);
			if (!venue || nameParts.length === 0) throw new Error("Usage: rename <id> <new name>");
			venue.name = nameParts.join(" ");
			registry.dirtyVenues.add(id);
			registry.addAlias(venue.name, id);
			await registry.commit();
			console.log(`Renamed ${id} to "${venue.name}"`);
			break;
		}
		case "alias": {
			const [id, ...nameParts] = args;
			if (!registry.venues.get(id) || nameParts.length === 0) {
				throw new Error("Usage: alias <id> <raw name>");
			}
			registry.addAlias(nameParts.join(" "), id);
			await registry.commit();
			console.log(`Added alias to ${id}`);
			break;
		}
		default:
			console.log("Commands: stats | venues [search] | venue <id> | merge <from> <into> | rename <id> <name> | alias <id> <name>");
	}
}

main().catch((error) => {
	console.error(error.message);
	process.exit(1);
});
