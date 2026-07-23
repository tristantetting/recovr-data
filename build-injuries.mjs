/**
 * Recovr — Google Sheet ➜ injuries.json
 *
 * Reads every region tab from the injury bank spreadsheet, cleans the rows,
 * and writes a single injuries.json file that the website loads from a CDN.
 *
 * Run it yourself with:  node build-injuries.mjs
 */

import fs from "node:fs/promises"
import crypto from "node:crypto"
import Papa from "papaparse"

/* ------------------------------------------------------------------ */
/* EDIT THESE TWO THINGS                                               */
/* ------------------------------------------------------------------ */

// The long chunk from your sheet's URL, between /d/ and /edit
const SHEET_ID = process.env.RECOVR_SHEET_ID || "1XLsGIdBjMWiJ_ljBHumEBEWQdHmVBaBE8vVfn8oyoK4"

// The name of every tab you want included — exact spelling and capitalization.
// Add a line whenever your team adds a region.
const TABS = [
    "ALL INJURIES",
]

/* ------------------------------------------------------------------ */
/* Column mapping — left side is the header in your sheet,             */
/* right side is the name the website code uses.                       */
/* ------------------------------------------------------------------ */

const COLUMNS = {
    Name: "Name",
    Slug: "Slug",
    Region: "Region",
    Format: "Format",
    Overview: "Overview",
    "Symptoms List": "Symptoms List",
    "Format 2": "Format 2",
    "What It May Feel Like": "What It May Feel Like",
    "Format 3": "Format 3",
    "Common Causes": "Common Causes",
    "Self Check": "Self Check",
    "What To Do": "What To Do",
    "Red Flags": "Red Flags",
    "Recovery Tips": "Recovery Tips",
    Tags: "Tags",
    Priority: "Priority",
    Links: "Links",
}

// Fields that should come out as a list instead of one long string
const LIST_FIELDS = new Set([
    "Symptoms List",
    "What It May Feel Like",
    "Common Causes",
    "Self Check",
    "What To Do",
    "Red Flags",
    "Recovery Tips",
])

const OUT_FILE = "injuries.json"

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const csvUrl = (tab) =>
    `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq` +
    `?tqx=out:csv&headers=1&sheet=${encodeURIComponent(tab)}`

async function fetchCsv(tab, attempt = 1) {
    const res = await fetch(csvUrl(tab))
    if (!res.ok) {
        if (attempt < 3) {
            await new Promise((r) => setTimeout(r, 1000 * attempt))
            return fetchCsv(tab, attempt + 1)
        }
        throw new Error(`Tab "${tab}" returned HTTP ${res.status}`)
    }
    return res.text()
}

// Turn a cell into a clean list. Prefers line breaks; falls back to commas
// when the whole thing sits on one line (some rows are written that way).
function splitList(raw) {
    if (!raw) return []
    const lines = String(raw)
        .split(/\r?\n/)
        .map((s) => s.replace(/^\s*(?:[•\-–—*]|\d+[.)])\s+/, "").trim())
        .filter(Boolean)

    if (lines.length > 1) return lines

    const single = lines[0] || ""
    if ((single.match(/,/g) || []).length >= 2) {
        return single
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
    }
    return single ? [single] : []
}

function splitTags(raw) {
    if (!raw) return []
    return String(raw)
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean)
}

function splitLinks(raw) {
    if (!raw) return []
    return String(raw)
        .split(/\s+/)
        .filter((s) => /^https?:\/\//i.test(s))
}

function cleanRow(row) {
    const out = {}

    for (const [header, key] of Object.entries(COLUMNS)) {
        const raw = (row[header] ?? "").toString().trim()

        if (LIST_FIELDS.has(key)) out[key] = splitList(raw)
        else if (key === "tags") out[key] = splitTags(raw)
        else if (key === "links") out[key] = splitLinks(raw)
        else if (key === "priority") out[key] = Number.parseInt(raw, 10) || 0
        else out[key] = raw
    }

    // Slug has to be lowercase with no spaces — enforce it rather than trust it
    if (out.slug) {
        out.slug = out.slug
            .toLowerCase()
            .replace(/\s+/g, "-")
            .replace(/[^a-z0-9-]/g, "")
    }

    return out
}

// A row counts as a real injury only if it has both a name and a slug.
// This skips the instructions block and the formatting example.
function isRealInjury(row) {
    return Boolean(row.name && row.slug && row.name.length < 120)
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
    if (SHEET_ID === "PASTE_YOUR_SHEET_ID_HERE") {
        throw new Error("Set SHEET_ID at the top of this file first.")
    }

    const injuries = []
    const problems = []

    for (const tab of TABS) {
        let csv
        try {
            csv = await fetchCsv(tab)
        } catch (err) {
            problems.push(`Could not read tab "${tab}": ${err.message}`)
            continue
        }

        const parsed = Papa.parse(csv, {
            header: true,
            skipEmptyLines: "greedy",
        })

        const rows = parsed.data.map(cleanRow).filter(isRealInjury)

        // Fall back to the tab name if the Region cell was left blank
        for (const row of rows) {
            if (!row.region) row.region = tab
        }

        if (rows.length === 0) {
            problems.push(`Tab "${tab}" produced 0 injuries — check the headers.`)
        }

        console.log(`  ${tab.padEnd(18)} ${rows.length} injuries`)
        injuries.push(...rows)
    }

    // Warn about duplicate slugs — these break detail page routing
    const seen = new Map()
    for (const injury of injuries) {
        if (seen.has(injury.slug)) {
            problems.push(
                `Duplicate slug "${injury.slug}" (${seen.get(injury.slug)} and ${injury.name})`
            )
        } else {
            seen.set(injury.slug, injury.name)
        }
    }

    injuries.sort(
        (a, b) =>
            a.region.localeCompare(b.region) ||
            b.priority - a.priority ||
            a.name.localeCompare(b.name)
    )

    const regions = [...new Set(injuries.map((i) => i.region))].sort()

    // Only rewrite the file when the content actually changed, so the daily
    // run doesn't create a pointless commit every morning.
    const fingerprint = crypto
        .createHash("sha1")
        .update(JSON.stringify(injuries))
        .digest("hex")

    let previous = null
    try {
        previous = JSON.parse(await fs.readFile(OUT_FILE, "utf8"))
    } catch {}

    if (previous?.fingerprint === fingerprint) {
        console.log("\nNo changes since last build.")
    } else {
        await fs.writeFile(
            OUT_FILE,
            JSON.stringify(
                {
                    generatedAt: new Date().toISOString(),
                    fingerprint,
                    count: injuries.length,
                    regions,
                    injuries,
                },
                null,
                0
            )
        )
        console.log(`\nWrote ${OUT_FILE} — ${injuries.length} injuries.`)
    }

    if (problems.length) {
        console.log("\nWorth a look:")
        for (const p of problems) console.log("  • " + p)
    }

    if (injuries.length === 0) {
        throw new Error("No injuries found. Check SHEET_ID and the TABS list.")
    }
}

main().catch((err) => {
    console.error("\nBuild failed: " + err.message)
    process.exit(1)
})
