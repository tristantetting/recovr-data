/**
 * Recovr — Google Sheets ➜ injuries.json + questions.json
 *
 * Reads two spreadsheets and writes two prebuilt JSON files the website
 * loads from the CDN:
 *
 *   injuries.json   — the injury bank (one tab)
 *   questions.json  — the intake questionnaire (one tab per region)
 *
 * Run it yourself with:  node build-injuries.mjs
 */

import fs from "node:fs/promises"
import crypto from "node:crypto"
import Papa from "papaparse"

/* ================================================================== */
/* CONFIG                                                             */
/* ================================================================== */

// Injury bank — one big tab
const INJURY_SHEET_ID =
    process.env.RECOVR_SHEET_ID ||
    "1XLsGIdBjMWiJ_ljBHumEBEWQdHmVBaBE8vVfn8oyoK4"
const INJURY_TABS = ["ALL INJURIES"]

// Intake questions — one tab per region. List the tab names exactly.
const QUESTION_SHEET_ID =
    process.env.RECOVR_QUESTIONS_SHEET_ID ||
    "1NP8l85vfreNq0LtRUaoCGOFJrcBNPb1GWVRsw3NrAic"
const QUESTION_TABS = [
    "head",
    "shoulder",
    "chest",
    "abdomen",
    "groin",
    "thigh",
    "knee",
    "lower-leg",
    "ankle-foot",
    "arm-hand-wrist",
    "upper-back",
    "lowerback-glutes",
    "hamstrings",
]

/* ------------------------------------------------------------------ */
/* Injury column mapping — sheet header : website field               */
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

/* ================================================================== */
/* Shared helpers                                                     */
/* ================================================================== */

function normalize(value) {
    return String(value ?? "")
        .replace(/\uFEFF/g, "")
        .replace(/\u00A0/g, " ")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ")
}

function gvizUrl(sheetId, tab) {
    return (
        `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq` +
        `?tqx=out:csv&sheet=${encodeURIComponent(tab)}`
    )
}

async function fetchCsv(sheetId, tab, attempt = 1) {
    const res = await fetch(gvizUrl(sheetId, tab))
    if (!res.ok) {
        if (attempt < 3) {
            await new Promise((r) => setTimeout(r, 1000 * attempt))
            return fetchCsv(sheetId, tab, attempt + 1)
        }
        throw new Error(`HTTP ${res.status}`)
    }
    const text = await res.text()
    if (/^\s*(<!doctype|<html)/i.test(text)) {
        throw new Error(
            "Google returned a sign-in page instead of data. Open the sheet, " +
                'click Share, and set General access to "Anyone with the link" / Viewer.'
        )
    }
    return text
}

/** Only rewrite a file when its content changed, so the daily run stays quiet. */
async function writeIfChanged(file, dataObject) {
    const body = { ...dataObject }
    const fingerprint = crypto
        .createHash("sha1")
        .update(JSON.stringify(body.__hashOn ?? body))
        .digest("hex")
    delete body.__hashOn
    body.fingerprint = fingerprint

    let previous = null
    try {
        previous = JSON.parse(await fs.readFile(file, "utf8"))
    } catch {}

    if (previous?.fingerprint === fingerprint) {
        console.log(`  ${file}: no change`)
        return false
    }
    await fs.writeFile(file, JSON.stringify(body))
    console.log(`  ${file}: written`)
    return true
}

/* ================================================================== */
/* INJURIES                                                           */
/* ================================================================== */

function findHeaderRow(rows) {
    const limit = Math.min(rows.length, 10)
    for (let i = 0; i < limit; i++) {
        const cells = new Set((rows[i] || []).map(normalize))
        if (cells.has("name") && cells.has("slug")) return i
    }
    return -1
}

function splitOutsideParens(text) {
    const out = []
    let depth = 0
    let cur = ""
    for (const ch of text) {
        if (ch === "(") depth++
        else if (ch === ")") depth = Math.max(0, depth - 1)
        if (ch === "," && depth === 0) {
            out.push(cur)
            cur = ""
        } else cur += ch
    }
    out.push(cur)
    return out.map((s) => s.trim()).filter(Boolean)
}

function stripBullet(text) {
    return text.replace(/^\s*(?:[•\-–—*]|\d+[.)])\s+/, "").trim()
}

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

function splitList(raw) {
    if (!raw) return []
    const lines = String(raw).split(/\r?\n/).map(stripBullet).filter(Boolean)
    if (lines.length > 1) return lines
    if (lines.length === 0) return []
    return splitSingleLine(lines[0])
}

function finishInjuryRow(row) {
    const out = {}
    for (const key of Object.values(COLUMNS)) {
        const raw = (row[key] ?? "").toString().trim()
        if (LIST_FIELDS.has(key)) out[key] = splitList(raw)
        else if (key === "tags")
            out[key] = raw
                .split(/[\s,]+/)
                .map((t) => t.replace(/`/g, ""))
                .filter(Boolean)
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

function isRealInjury(row) {
    return Boolean(row.name && row.slug && row.name.length < 120)
}

async function buildInjuries(problems) {
    const HEADER_LOOKUP = Object.fromEntries(
        Object.entries(COLUMNS).map(([h, k]) => [normalize(h), k])
    )
    const injuries = []

    for (const tab of INJURY_TABS) {
        let csv
        try {
            csv = await fetchCsv(INJURY_SHEET_ID, tab)
        } catch (err) {
            problems.push(`Injuries "${tab}": ${err.message}`)
            continue
        }

        const grid = Papa.parse(csv, {
            header: false,
            skipEmptyLines: "greedy",
        }).data
        const headerIndex = findHeaderRow(grid)
        if (headerIndex === -1) {
            problems.push(`Injuries "${tab}": no Name+Slug header row found.`)
            continue
        }

        const keys = grid[headerIndex].map((h) => HEADER_LOOKUP[normalize(h)] || null)

        const rows = grid
            .slice(headerIndex + 1)
            .map((cells) => {
                const obj = {}
                keys.forEach((key, i) => {
                    if (key) obj[key] = cells[i] ?? ""
                })
                return finishInjuryRow(obj)
            })
            .filter(isRealInjury)

        for (const r of rows) if (!r.region) r.region = tab
        injuries.push(...rows)
    }

    // report duplicate slugs but keep everything
    const seen = new Map()
    for (const inj of injuries) {
        if (seen.has(inj.slug))
            problems.push(
                `Duplicate slug "${inj.slug}" — ${seen.get(inj.slug)} and ${inj.region}`
            )
        else seen.set(inj.slug, inj.region)
    }

    injuries.sort(
        (a, b) =>
            a.region.localeCompare(b.region) ||
            b.priority - a.priority ||
            a.name.localeCompare(b.name)
    )
    const regions = [...new Set(injuries.map((i) => i.region))].sort()

    console.log(`Injuries: ${injuries.length} across ${regions.length} regions`)
    if (injuries.length === 0) throw new Error("No injuries parsed.")

    await writeIfChanged("injuries.json", {
        generatedAt: new Date().toISOString(),
        count: injuries.length,
        regions,
        injuries,
        __hashOn: injuries,
    })

    return injuries
}

/* ================================================================== */
/* QUESTIONS                                                          */
/* ================================================================== */

// Options carry a region prefix (head_onset_sudden, ankle-foot_onset_sudden,
// Arms-Hands-Wrists_onset_sudden); injuries use the bare tag (onset_sudden).
// The prefixes are inconsistent — some hyphenated, some the tab name, some the
// region name — so instead of guessing the prefix, we anchor on the KNOWN
// tag buckets and keep everything from the first bucket onward.
const TAG_BUCKETS = [
    "onset",
    "mech",
    "prov",
    "quality",
    "loc",
    "timing",
    "function",
    "rom",
    "app",
    "neuro",
    "extra",
    "redflag",
    "relief",
    "age",
]

function stripRegionPrefix(tag) {
    const clean = String(tag ?? "")
        .trim()
        .replace(/`/g, "")
        .toLowerCase()
    if (!clean) return ""

    const parts = clean.split("_")
    // Find the first part that is a known bucket, and keep from there.
    const bucketIndex = parts.findIndex((p) => TAG_BUCKETS.includes(p))
    if (bucketIndex >= 0) return parts.slice(bucketIndex).join("_")

    // No known bucket — fall back to dropping the first token.
    return parts.length > 1 ? parts.slice(1).join("_") : clean
}

function buildRegionQuestions(csv) {
    const rows = Papa.parse(csv, {
        header: true,
        skipEmptyLines: "greedy",
    }).data.filter((r) => r.OptionLabel && r.OptionLabel.trim() && r.QuestionKey)

    if (!rows.length) return null
    const region = String(rows[0].Region ?? "").trim()

    const qmap = new Map()
    for (const r of rows) {
        const key = String(r.QuestionKey).trim()
        if (!qmap.has(key)) {
            const multi = String(r.MultiSelect).toUpperCase() === "TRUE"
            qmap.set(key, {
                key,
                order: Number.parseInt(r.Order, 10) || 0,
                prompt: String(r.Prompt ?? "").trim(),
                helper: String(r.Helper ?? "").trim(),
                multiSelect: multi,
                maxSelect: Number.parseInt(r.MaxSelect, 10) || (multi ? 2 : 1),
                options: [],
            })
        }
        qmap.get(key).options.push({
            label: String(r.OptionLabel).trim(),
            tag: stripRegionPrefix(r.Tag),
            weight: Number.parseFloat(r.Weight) || 1,
        })
    }

    const questions = [...qmap.values()].sort((a, b) => a.order - b.order)
    return { region, questions }
}

async function buildQuestions(problems) {
    const byRegion = {}

    for (const tab of QUESTION_TABS) {
        let csv
        try {
            csv = await fetchCsv(QUESTION_SHEET_ID, tab)
        } catch (err) {
            problems.push(`Questions "${tab}": ${err.message}`)
            continue
        }

        const built = buildRegionQuestions(csv)
        if (!built) {
            problems.push(`Questions "${tab}": no usable rows.`)
            continue
        }
        if (byRegion[built.region]) {
            problems.push(
                `Questions: two tabs map to region "${built.region}" — second one wins.`
            )
        }
        byRegion[built.region] = built.questions
    }

    const regions = Object.keys(byRegion).sort()
    const totalOptions = regions.reduce(
        (s, r) => s + byRegion[r].reduce((n, q) => n + q.options.length, 0),
        0
    )
    console.log(
        `Questions: ${regions.length} regions, ${totalOptions} options total`
    )
    if (regions.length === 0) throw new Error("No questions parsed.")

    await writeIfChanged("questions.json", {
        generatedAt: new Date().toISOString(),
        regions,
        byRegion,
        __hashOn: byRegion,
    })

    return byRegion
}

/* ================================================================== */
/* Cross-check                                                        */
/* ================================================================== */

function crossCheck(injuries, byRegion, problems) {
    const injTags = new Set()
    injuries.forEach((i) => i.tags.forEach((t) => injTags.add(t.toLowerCase())))

    for (const region of Object.keys(byRegion)) {
        const hasInjuries = injuries.some((i) => i.region === region)
        if (!hasInjuries) {
            problems.push(
                `Region "${region}" has questions but no injuries in the bank yet.`
            )
        }
    }
}

/* ================================================================== */
/* Main                                                               */
/* ================================================================== */

async function main() {
    const problems = []

    console.log("Building data files…")
    const injuries = await buildInjuries(problems)
    const byRegion = await buildQuestions(problems)
    crossCheck(injuries, byRegion, problems)

    if (problems.length) {
        console.log("\nWorth a look:")
        for (const p of problems) console.log("  • " + p)
    }
    console.log("\nDone.")
}

main().catch((err) => {
    console.error("\nBuild failed: " + err.message)
    process.exit(1)
})
