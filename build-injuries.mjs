/**
 * Recovr — Google Sheet ➜ injuries.json
 *
 * Reads the injury bank tab(s), cleans the rows, and writes injuries.json
 * for the website to load from a CDN.
 *
 * Run it yourself with:  node build-injuries.mjs
 */

import fs from "node:fs/promises"
import crypto from "node:crypto"
import Papa from "papaparse"

/* ------------------------------------------------------------------ */
/* EDIT THESE TWO THINGS                                               */
/* ------------------------------------------------------------------ */

const SHEET_ID =
    process.env.RECOVR_SHEET_ID ||
    "1XLsGIdBjMWiJ_ljBHumEBEWQdHmVBaBE8vVfn8oyoK4"

const TABS = ["ALL INJURIES"]

/* ------------------------------------------------------------------ */
/* Column mapping — left side is the header in your sheet,             */
/* right side is the name the website code uses.                       */
/* Matching ignores capitalization and extra spaces.                   */
/* ------------------------------------------------------------------ */

const COLUMNS = {
    Name: "name",
    Slug: "slug",
    Region: "region",
    Format: "overviewHeading",
    Overview: "overview",
    "Symptoms List": "symptoms",
    "Format 2": "feelsLikeHeading",
    "What It May Feel Like": "feelsLike",
    "Format 3": "causesHeading",
    "Common Causes": "causes",
    "Self Check": "selfCheck",
    "What To Do": "whatToDo",
    "Red Flags": "redFlags",
    "Recovery Tips": "recoveryTips",
    Tags: "tags",
    Priority: "priority",
    Links: "links",
}

const LIST_FIELDS = new Set([
    "symptoms",
    "feelsLike",
    "causes",
    "selfCheck",
    "whatToDo",
    "redFlags",
    "recoveryTips",
])

const OUT_FILE = "injuries.json"

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Strip invisible characters, collapse spaces, lowercase. */
function normalize(value) {
    return String(value ?? "")
        .replace(/\uFEFF/g, "")
        .replace(/\u00A0/g, " ")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ")
}

// normalized sheet header -> website key
const HEADER_LOOKUP = Object.fromEntries(
    Object.entries(COLUMNS).map(([header, key]) => [normalize(header), key])
)

const csvUrl = (tab) =>
    `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq` +
    `?tqx=out:csv&sheet=${encodeURIComponent(tab)}`

async function fetchCsv(tab, attempt = 1) {
    const res = await fetch(csvUrl(tab))
    if (!res.ok) {
        if (attempt < 3) {
            await new Promise((r) => setTimeout(r, 1000 * attempt))
            return fetchCsv(tab, attempt + 1)
        }
        throw new Error(`HTTP ${res.status}`)
    }

    const text = await res.text()

    // If the sheet isn't link-shared, Google hands back a sign-in page
    // with a normal 200 status. Catch that specifically.
    if (/^\s*(<!doctype|<html)/i.test(text)) {
        throw new Error(
            "Google returned a sign-in page instead of data. " +
                "Open the sheet, click Share, and set General access to " +
                '"Anyone with the link" / Viewer.'
        )
    }

    return text
}

/**
 * Find the row holding the column headers. Usually row 1, but a banner or
 * instructions row above it is common, so scan the first several rows for
 * one containing both Name and Slug.
 */
function findHeaderRow(rows) {
    const limit = Math.min(rows.length, 10)
    for (let i = 0; i < limit; i++) {
        const cells = new Set((rows[i] || []).map(normalize))
        if (cells.has("name") && cells.has("slug")) return i
    }
    return -1
}

/** Split on commas, but never inside parentheses. */
function splitOutsideParens(text) {
    const out = []
    let depth = 0
    let current = ""

    for (const char of text) {
        if (char === "(") depth++
        else if (char === ")") depth = Math.max(0, depth - 1)

        if (char === "," && depth === 0) {
            out.push(current)
            current = ""
        } else {
            current += char
        }
    }
    out.push(current)

    return out.map((s) => s.trim()).filter(Boolean)
}

/** Strip a leading bullet or "1." style marker. */
function stripBullet(text) {
    return text.replace(/^\s*(?:[•\-–—*]|\d+[.)])\s+/, "").trim()
}

/**
 * Decide how to break a single line of text into list items.
 *
 * Volunteers write these cells three different ways, so this reads the
 * punctuation to work out which one they used:
 *
 *   1. Capitalized items ("Bruising, Redness, Swelling") — split at the
 *      commas that come before a capital letter, so commas *inside* an
 *      item survive intact.
 *   2. Full paragraphs — leave alone. Marked by real sentence breaks or by
 *      long stretches between commas.
 *   3. Lowercase items ("nosebleed, pain when touching nose") — split at
 *      every comma outside parentheses.
 */
function splitSingleLine(text) {
    const byCapital = text
        .split(/,\s*(?=[A-Z])/)
        .map((s) => s.trim())
        .filter(Boolean)
    if (byCapital.length > 1) return byCapital

    const pieces = splitOutsideParens(text)
    const hasSentenceBreak = /[.!?]["”]?\s+["“A-Z]/.test(text)
    const averagePiece = text.length / pieces.length

    if (hasSentenceBreak || averagePiece >= 30) return [text]

    return pieces
}

/** Turn a cell into a clean list. Line breaks always win. */
function splitList(raw) {
    if (!raw) return []

    const lines = String(raw)
        .split(/\r?\n/)
        .map(stripBullet)
        .filter(Boolean)

    if (lines.length > 1) return lines
    if (lines.length === 0) return []

    return splitSingleLine(lines[0])
}

function finishRow(row) {
    const out = {}

    for (const key of Object.values(COLUMNS)) {
        const raw = (row[key] ?? "").toString().trim()

        if (LIST_FIELDS.has(key)) out[key] = splitList(raw)
        else if (key === "tags") out[key] = raw.split(/[\s,]+/).filter(Boolean)
        else if (key === "links")
            out[key] = raw
                .split(/[\s,]+/)
                .filter((s) => /^https?:\/\//i.test(s))
                .map((s) => s.replace(/[.,)]+$/, ""))
        else if (key === "priority") out[key] = Number.parseInt(raw, 10) || 0
        else out[key] = raw.replace(/\s+/g, " ").trim()
    }

    if (out.slug) {
        out.slug = out.slug
            .toLowerCase()
            .replace(/\s+/g, "-")
            .replace(/[^a-z0-9-]/g, "")
    }

    return out
}

// A row counts as a real injury only if it has both a name and a slug.
// This skips instruction blocks and formatting examples.
function isRealInjury(row) {
    return Boolean(row.name && row.slug && row.name.length < 120)
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
    const injuries = []
    const problems = []

    for (const tab of TABS) {
        console.log(`\nReading tab "${tab}"`)

        let csv
        try {
            csv = await fetchCsv(tab)
        } catch (err) {
            problems.push(`Tab "${tab}": ${err.message}`)
            console.log(`  ${err.message}`)
            continue
        }

        const grid = Papa.parse(csv, {
            header: false,
            skipEmptyLines: "greedy",
        }).data

        console.log(`  ${grid.length} rows came back`)

        const headerIndex = findHeaderRow(grid)

        if (headerIndex === -1) {
            console.log("  Could not find a header row. Top rows look like:")
            grid.slice(0, 3).forEach((r, i) => {
                console.log(
                    `    row ${i + 1}: ${JSON.stringify(r).slice(0, 400)}`
                )
            })
            problems.push(`Tab "${tab}": no row contains both "Name" and "Slug".`)
            continue
        }

        if (headerIndex > 0) {
            console.log(
                `  Headers found on row ${headerIndex + 1} (skipped ${headerIndex} row(s) above)`
            )
        }

        const headerCells = grid[headerIndex].map(normalize)
        const keys = headerCells.map((h) => HEADER_LOOKUP[h] || null)

        const unmatched = headerCells.filter((h, i) => h && !keys[i])
        if (unmatched.length) {
            console.log(`  Columns being ignored: ${unmatched.join(", ")}`)
        }

        const missing = Object.values(COLUMNS).filter((k) => !keys.includes(k))
        if (missing.length) {
            console.log(`  Columns not found in the sheet: ${missing.join(", ")}`)
        }

        const rows = grid
            .slice(headerIndex + 1)
            .map((cells) => {
                const obj = {}
                keys.forEach((key, i) => {
                    if (key) obj[key] = cells[i] ?? ""
                })
                return finishRow(obj)
            })
            .filter(isRealInjury)

        for (const row of rows) {
            if (!row.region) row.region = tab
        }

        console.log(`  ${rows.length} injuries`)

        if (rows.length === 0) {
            problems.push(
                `Tab "${tab}": headers matched but no row had both a Name and a Slug.`
            )
        }

        injuries.push(...rows)
    }

    // Duplicate slugs are reported, but every injury is still kept.
    const seen = new Map()
    for (const injury of injuries) {
        if (seen.has(injury.slug)) {
            problems.push(
                `Duplicate slug "${injury.slug}" — ${seen.get(injury.slug)} and ${injury.region}`
            )
        } else {
            seen.set(injury.slug, injury.region)
        }
    }

    // Empty required fields are worth knowing about
    for (const injury of injuries) {
        const blanks = ["overview", "symptoms", "whatToDo", "redFlags"].filter(
            (f) => !injury[f] || injury[f].length === 0
        )
        if (blanks.length) {
            problems.push(`${injury.name}: empty ${blanks.join(", ")}`)
        }
    }

    injuries.sort(
        (a, b) =>
            a.region.localeCompare(b.region) ||
            b.priority - a.priority ||
            a.name.localeCompare(b.name)
    )

    const regions = [...new Set(injuries.map((i) => i.region))].sort()

    if (injuries.length === 0) {
        if (problems.length) {
            console.log("\nWorth a look:")
            for (const p of problems) console.log("  • " + p)
        }
        throw new Error("No injuries found — nothing was written.")
    }

    // Only rewrite when the content actually changed, so the daily run
    // doesn't create a pointless commit every morning.
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
            JSON.stringify({
                generatedAt: new Date().toISOString(),
                fingerprint,
                count: injuries.length,
                regions,
                injuries,
            })
        )
        console.log(`\nWrote ${OUT_FILE} — ${injuries.length} injuries.`)
        console.log(`Regions: ${regions.join(", ")}`)
    }

    if (problems.length) {
        console.log("\nWorth a look:")
        for (const p of problems) console.log("  • " + p)
    }
}

main().catch((err) => {
    console.error("\nBuild failed: " + err.message)
    process.exit(1)
})
