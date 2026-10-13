# Shram Saathi API
Node.js + Express backend for the Shram Saathi website.

Run locally: `npm install`, copy `.env.example` to `.env`, then `npm run dev`.
Test: http://localhost:3000/api/health

Endpoints: GET /api/health, /api/schemes, /api/pension?age=25, /api/stats;
POST /api/eligibility, /api/register; GET /api/admin/registrations (header x-admin-key).
