"use strict";
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { MongoClient } = require("mongodb");

const app = express();
app.set("trust proxy", 1);
const PORT = process.env.PORT || 3000;
const ORIGINS = (process.env.ALLOWED_ORIGIN || "*").split(",").map(s => s.trim()).filter(Boolean);
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");

app.use(helmet());
app.use(cors({ origin: ORIGINS.includes("*") ? true : ORIGINS }));
app.use(express.json({ limit: "10kb" }));
app.use("/api", rateLimit({ windowMs: 15 * 60 * 1000, limit: 100, standardHeaders: true, legacyHeaders: false }));
const registerLimit = rateLimit({ windowMs: 60 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, message: { error: "Too many submissions. Please try again later." } });

/* ---------- Data ---------- */
const SCHEMES = [
  { id: "eshram", name: "e-Shram", summary: "Registration and social security for unorganised workers.", url: "https://eshram.gov.in", helpline: "14434" },
  { id: "pmsym", name: "PM Shram Yogi Maandhan", summary: "Pension of Rs 3,000 per month after age 60.", url: "https://maandhan.in", helpline: "1800-267-6888" },
  { id: "pmjay", name: "Ayushman Bharat PM-JAY", summary: "Health cover of Rs 5 lakh per family per year.", url: "https://pmjay.gov.in", helpline: "14555" },
  { id: "pmjdy", name: "PM Jan Dhan Yojana", summary: "Zero-balance bank account, RuPay card and insurance.", url: "https://pmjdy.gov.in", helpline: "" }
];
const PENSION = { 18:55,19:58,20:61,21:64,22:68,23:72,24:76,25:80,26:85,27:90,28:95,29:100,30:105,31:110,32:120,33:130,34:140,35:150,36:160,37:170,38:180,39:190,40:200 };
const OCCUPATIONS = ["Street vendor", "Domestic worker", "Construction worker", "Gig / delivery worker", "Home-based worker", "Waste picker", "Other"];
const INTERESTS = SCHEMES.map(s => s.id);

/* ---------- Storage: MongoDB Atlas (JSON file fallback if MONGODB_URI is not set) ---------- */
const MONGODB_URI = process.env.MONGODB_URI || "";
let col = null;
async function initDb() {
  if (!MONGODB_URI) { console.warn("MONGODB_URI not set: using a local JSON file. Data can be lost on restart."); return; }
  const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  col = client.db(process.env.DB_NAME || "shram_saathi").collection("registrations");
  await col.createIndex({ phone: 1 }, { unique: true });
  await col.createIndex({ createdAt: -1 });
  console.log("MongoDB connected");
}
const FILE = "registrations.json";
async function readFile() {
  try { return JSON.parse(await fs.readFile(path.join(DATA_DIR, FILE), "utf8")); } catch { return []; }
}
let queue = Promise.resolve();
async function readAll() {
  if (col) return col.find({}, { projection: { _id: 0 } }).sort({ createdAt: -1 }).toArray();
  return readFile();
}
async function addRecord(rec) {
  if (col) {
    try { await col.insertOne({ ...rec }); }
    catch (e) { if (e.code === 11000) { const d = new Error("dup"); d.code = "DUP"; throw d; } throw e; }
    return;
  }
  const job = queue.catch(() => {}).then(async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const all = await readFile();
    if (all.some(r => r.phone === rec.phone)) { const e = new Error("dup"); e.code = "DUP"; throw e; }
    all.push(rec);
    await fs.writeFile(path.join(DATA_DIR, FILE), JSON.stringify(all, null, 2));
  });
  queue = job;
  return job;
}
async function getStats() {
  const byOccupation = {};
  if (col) {
    const registered = await col.countDocuments();
    (await col.aggregate([{ $group: { _id: "$occupation", n: { $sum: 1 } } }]).toArray()).forEach(a => { byOccupation[a._id] = a.n; });
    return { registered, byOccupation };
  }
  const all = await readFile();
  all.forEach(r => { byOccupation[r.occupation] = (byOccupation[r.occupation] || 0) + 1; });
  return { registered: all.length, byOccupation };
}
const clean = (s, max) => String(s ?? "").replace(/[<>]/g, "").trim().slice(0, max);

/* ---------- Logic ---------- */
function evaluate(i) {
  const age = Number(i.age), inc = Number(i.income) || 0;
  const pf = i.pf === "y", tax = i.tax === "y", bank = i.bank === "y", secc = i.secc;
  const excluded = pf || tax;
  const res = [];
  res.push(age >= 16 && age <= 59 && !excluded
    ? { name: "e-Shram", status: "ok", headline: "Likely eligible", message: "Register for free at eshram.gov.in." }
    : { name: "e-Shram", status: "no", headline: "May not be eligible", message: age < 16 || age > 59 ? "Age must be 16-59." : "EPFO/ESIC/NPS members and income tax payers are excluded." });
  const okP = age >= 18 && age <= 40 && inc <= 15000 && !excluded;
  res.push(okP
    ? { name: "PMSYM Pension", status: "ok", headline: "Likely eligible", message: "Your monthly contribution would be Rs " + PENSION[age] + ", matched by the Government." }
    : { name: "PMSYM Pension", status: "no", headline: "May not be eligible", message: age < 18 || age > 40 ? "Age must be 18-40." : inc > 15000 ? "Income must be Rs 15,000/month or less." : "EPFO/ESIC/NPS members and tax payers are excluded." });
  res.push(secc === "y"
    ? { name: "Ayushman Bharat", status: "ok", headline: "Likely eligible", message: "Get your Ayushman card at a CSC or hospital." }
    : secc === "n"
      ? { name: "Ayushman Bharat", status: "no", headline: "Probably not on the central list", message: "Check your state scheme or ask the ward office." }
      : { name: "Ayushman Bharat", status: "chk", headline: "Check your name", message: "Use mera.pmjay.gov.in or call 14555." });
  res.push(!bank
    ? { name: "PM Jan Dhan", status: "ok", headline: "Eligible", message: "Open a zero-balance account at any bank (age 10+)." }
    : { name: "PM Jan Dhan", status: "chk", headline: "Already banked", message: "Ask your bank to convert it to a Jan Dhan account for RuPay card and insurance benefits." });
  return res;
}

/* ---------- Public routes ---------- */
app.get("/", (req, res) => res.json({ service: "Shram Saathi API", ok: true }));
app.get("/api/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.get("/api/schemes", (req, res) => res.json({ schemes: SCHEMES }));

app.get("/api/pension", (req, res) => {
  const age = Number(req.query.age);
  if (!Number.isInteger(age) || age < 18 || age > 40) return res.status(400).json({ error: "Age must be a whole number from 18 to 40." });
  const monthly = PENSION[age], years = 60 - age, own = monthly * 12 * years;
  res.json({ age, monthly, years, ownTotal: own, withGovernment: own * 2, pension: 3000 });
});

app.post("/api/eligibility", (req, res) => {
  const b = req.body || {};
  const age = Number(b.age), inc = Number(b.income);
  if (!Number.isInteger(age) || age < 1 || age > 100) return res.status(400).json({ error: "Enter a valid age (1-100)." });
  if (b.income !== undefined && b.income !== "" && (!Number.isFinite(inc) || inc < 0 || inc > 10000000)) return res.status(400).json({ error: "Enter a valid income." });
  for (const k of ["pf", "tax", "bank"]) if (!["y", "n"].includes(b[k])) return res.status(400).json({ error: "Invalid value for " + k + "." });
  if (!["y", "n", "u"].includes(b.secc)) return res.status(400).json({ error: "Invalid value for secc." });
  res.json({ results: evaluate(b) });
});

app.post("/api/register", registerLimit, async (req, res, next) => {
  try {
    const b = req.body || {};
    const name = clean(b.name, 60), city = clean(b.city, 60), phone = String(b.phone || "").replace(/\s/g, "");
    const occupation = clean(b.occupation, 40);
    const interests = Array.isArray(b.interests) ? b.interests.filter(x => INTERESTS.includes(x)) : [];
    if (name.length < 2) return res.status(400).json({ error: "Please enter your full name." });
    if (!/^[6-9]\d{9}$/.test(phone)) return res.status(400).json({ error: "Enter a valid 10-digit mobile number." });
    if (city.length < 2) return res.status(400).json({ error: "Please enter your city or ward." });
    if (!OCCUPATIONS.includes(occupation)) return res.status(400).json({ error: "Please choose an occupation." });
    if (!interests.length) return res.status(400).json({ error: "Choose at least one scheme." });
    if (b.consent !== true) return res.status(400).json({ error: "Please tick the consent box." });
    await addRecord({ id: crypto.randomUUID(), name, phone, city, occupation, interests, createdAt: new Date().toISOString() });
    res.status(201).json({ ok: true });
  } catch (e) {
    if (e.code === "DUP") return res.status(409).json({ error: "This mobile number is already registered." });
    next(e);
  }
});

app.get("/api/stats", async (req, res, next) => {
  try { res.json(await getStats()); } catch (e) { next(e); }
});

/* ---------- Admin ---------- */
function adminOnly(req, res, next) {
  if (!ADMIN_KEY) return res.status(503).json({ error: "Admin access is not configured." });
  const a = Buffer.from(String(req.get("x-admin-key") || "")), b = Buffer.from(ADMIN_KEY);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: "Unauthorized" });
  next();
}
app.get("/api/admin/registrations", adminOnly, async (req, res, next) => {
  try { res.json({ registrations: await readAll() }); } catch (e) { next(e); }
});
const csvCell = v => {
  let s = Array.isArray(v) ? v.join(" | ") : String(v ?? "");
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
};
app.get("/api/admin/registrations.csv", adminOnly, async (req, res, next) => {
  try {
    const rows = await readAll();
    const head = ["name", "phone", "city", "occupation", "interests", "createdAt"];
    const lines = [head.join(",")].concat(rows.map(r => head.map(h => csvCell(r[h])).join(",")));
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Content-Disposition", "attachment; filename=registrations.csv");
    res.send(lines.join("\n"));
  } catch (e) { next(e); }
});

const ADMIN_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shram Saathi Admin</title>
<style>body{font:16px system-ui,sans-serif;margin:0;padding:16px;max-width:1000px;margin:auto}input,button{font:inherit;padding:8px 12px;margin:4px 4px 4px 0}table{border-collapse:collapse;width:100%;margin-top:12px}th,td{border-bottom:1px solid #ccc;padding:6px;text-align:left;font-size:14px}.s{overflow-x:auto}</style></head>
<body><h1>Registrations</h1><input id="k" type="password" placeholder="Admin key"><button id="load">Load</button><button id="csv">Download CSV</button><div id="m"></div>
<div class="s"><table><thead><tr><th>Name</th><th>Phone</th><th>City</th><th>Occupation</th><th>Schemes</th><th>Date</th></tr></thead><tbody id="tb"></tbody></table></div>
<script>
const $=id=>document.getElementById(id);
async function get(p){const r=await fetch(p,{headers:{"x-admin-key":$("k").value}});if(!r.ok)throw new Error(r.status===401?"Wrong key":"Error "+r.status);return r}
$("load").onclick=async()=>{$("m").textContent="Loading...";try{const j=await(await get("/api/admin/registrations")).json();const tb=$("tb");tb.textContent="";
j.registrations.forEach(r=>{const tr=document.createElement("tr");[r.name,r.phone,r.city,r.occupation,(r.interests||[]).join(", "),new Date(r.createdAt).toLocaleString()].forEach(v=>{const td=document.createElement("td");td.textContent=v;tr.appendChild(td)});tb.appendChild(tr)});
$("m").textContent=j.registrations.length+" registrations"}catch(e){$("m").textContent=e.message}};
$("csv").onclick=async()=>{try{const b=await(await get("/api/admin/registrations.csv")).blob();const a=document.createElement("a");a.href=URL.createObjectURL(b);a.download="registrations.csv";a.click()}catch(e){$("m").textContent=e.message}};
</script></body></html>`;
app.get("/admin", (req, res) => {
  res.set("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'");
  res.type("html").send(ADMIN_HTML);
});

/* ---------- Errors ---------- */
app.use((req, res) => res.status(404).json({ error: "Not found" }));
app.use((err, req, res, next) => {
  if (err.status === 400 || err.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid request" });
  console.error(err);
  res.status(500).json({ error: "Server error" });
});

initDb()
  .then(() => app.listen(PORT, () => console.log("Shram Saathi API running on port " + PORT)))
  .catch(e => { console.error("Database connection failed:", e.message); process.exit(1); });
