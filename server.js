"use strict";
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

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

/* ---------- Storage (JSON file) ---------- */
const FILE = "registrations.json";
async function readAll() {
  try { return JSON.parse(await fs.readFile(path.join(DATA_DIR, FILE), "utf8")); } catch { return []; }
}
let queue = Promise.resolve();
function addRecord(rec) {
  const job = queue.catch(() => {}).then(async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const all = await readAll();
    if (all.some(r => r.phone === rec.phone)) { const e = new Error("dup"); e.code = "DUP"; throw e; }
    all.push(rec);
    await fs.writeFile(path.join(DATA_DIR, FILE), JSON.stringify(all, null, 2));
  });
  queue = job;
  return job;
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

app.get("/api/stats", async (req, res) => {
  const all = await readAll();
  const byOccupation = {};
  all.forEach(r => { byOccupation[r.occupation] = (byOccupation[r.occupation] || 0) + 1; });
  res.json({ registered: all.length, byOccupation });
});

/* ---------- Admin ---------- */
function adminOnly(req, res, next) {
  if (!ADMIN_KEY) return res.status(503).json({ error: "Admin access is not configured." });
  const a = Buffer.from(String(req.get("x-admin-key") || "")), b = Buffer.from(ADMIN_KEY);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: "Unauthorized" });
  next();
}
app.get("/api/admin/registrations", adminOnly, async (req, res) => res.json({ registrations: await readAll() }));

/* ---------- Errors ---------- */
app.use((req, res) => res.status(404).json({ error: "Not found" }));
app.use((err, req, res, next) => {
  if (err.status === 400 || err.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid request" });
  console.error(err);
  res.status(500).json({ error: "Server error" });
});

app.listen(PORT, () => console.log("Shram Saathi API running on port " + PORT));
