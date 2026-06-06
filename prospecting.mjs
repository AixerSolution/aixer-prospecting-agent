import Anthropic from "@anthropic-ai/sdk";
import * as fs from "fs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

const client = new Anthropic();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callWithRetry(fn, maxRetries = 4) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const is429 = err.message?.includes("429") || err.status === 429;
      if (is429 && attempt < maxRetries) {
        const wait = (attempt + 1) * 20000;
        console.log(`    ⏳ Rate limited — waiting ${wait / 1000}s before retry ${attempt + 1}/${maxRetries}...`);
        await sleep(wait);
      } else {
        throw err;
      }
    }
  }
}

// Load config (falls back to defaults if config.json not found)
let CONFIG = {};
try {
  CONFIG = JSON.parse(fs.readFileSync(new URL("./config.json", import.meta.url)));
} catch {
  CONFIG = {};
}

const MODEL = CONFIG.model || "claude-sonnet-4-6";

const SECTORS = CONFIG.sectors_rotation || [
  "Manufacturing & Logistics",
  "Retail & E-commerce",
  "Financial Services",
  "Professional Services",
  "Healthcare",
];

// Load search matrix from JSON file, fall back to inline defaults
let SEARCH_MATRIX_DATA = {};
try {
  SEARCH_MATRIX_DATA = JSON.parse(
    fs.readFileSync(new URL("./20_SEARCH_MATRIX.json", import.meta.url))
  );
} catch {
  // Inline fallback
}

function getSeedCompanies(sector) {
  return SEARCH_MATRIX_DATA.sectors?.[sector]?.seed_companies || [];
}

function getSearchQueries(sector) {
  if (SEARCH_MATRIX_DATA.sectors && SEARCH_MATRIX_DATA.sectors[sector]) {
    return SEARCH_MATRIX_DATA.sectors[sector].queries || [];
  }
  const fallback = {
    "Manufacturing & Logistics": [
      "Singapore manufacturing SME supply chain automation 2024",
      "Singapore warehouse hiring operations team 2024",
      "Singapore logistics startup expanding",
    ],
    "Retail & E-commerce": [
      "Singapore e-commerce platform Shopify 2024",
      "Singapore online store hiring customer support 2024",
      "Singapore D2C brand raising funding",
    ],
    "Financial Services": [
      "Singapore fintech startup hiring engineers 2024",
      "Singapore digital bank raising Series funding",
      "Singapore payment gateway Singapore",
    ],
    "Professional Services": [
      "Singapore law firm hiring technology roles 2024",
      "Singapore accounting firm automation",
      "Singapore consulting firm raising funding",
    ],
    Healthcare: [
      "Singapore telemedicine platform hiring 2024",
      "Singapore clinic management software",
      "Singapore healthcare startup fundraising",
    ],
  };
  return fallback[sector] || [];
}

function selectTodaysSector() {
  // Allow CLI override: node prospecting.mjs --sector "Healthcare"
  const sectorArg = process.argv.find((a) => a.startsWith("--sector="))?.split("=")[1]
    || (() => { const i = process.argv.indexOf("--sector"); return i !== -1 ? process.argv[i + 1] : null; })();
  if (sectorArg) return sectorArg;
  const dayOfWeek = new Date().getDay();
  return SECTORS[dayOfWeek % SECTORS.length];
}

function parseJSON(text) {
  const trimmed = text.trim();

  // Try 1: markdown code block
  const jsonMatch = trimmed.match(/```(?:json)?\n?([\s\S]*?)\n?```/);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[1]); } catch {}
  }

  // Try 2: direct parse
  try { return JSON.parse(trimmed); } catch {}

  // Try 3: extract first {...} block (objects before arrays to avoid false positives from [0-1] in text)
  const objStart = trimmed.indexOf("{");
  if (objStart !== -1) {
    const objEnd = trimmed.lastIndexOf("}");
    if (objEnd > objStart) {
      try { return JSON.parse(trimmed.slice(objStart, objEnd + 1)); } catch {}
    }
  }

  // Try 4: extract first [...] block
  const arrStart = trimmed.indexOf("[");
  if (arrStart !== -1) {
    const arrEnd = trimmed.lastIndexOf("]");
    if (arrEnd > arrStart) {
      try { return JSON.parse(trimmed.slice(arrStart, arrEnd + 1)); } catch {}
    }
  }

  console.error("Failed to parse JSON from response (first 300 chars):", trimmed.slice(0, 300));
  return null;
}

// AGENT 1: PROSPECTOR
async function runProspectorAgent(sector) {
  console.log(`\n🔍 PROSPECTOR AGENT: Searching for ${sector} companies...\n`);

  const seeds = getSeedCompanies(sector);
  let prompt;

  if (seeds.length > 0) {
    console.log(`  📌 Using ${seeds.length} verified seed companies from search matrix\n`);
    const seedList = seeds
      .map((s) => {
        let line = `- ${s.name}`;
        if (s.uen) line += ` (UEN: ${s.uen})`;
        if (s.bca_grade) line += `, BCA: ${s.bca_grade}`;
        if (s.website) line += `, website: ${s.website}`;
        if (s.known_contact) line += `, known contact: ${s.known_contact}`;
        return line;
      })
      .join("\n");

    prompt = `You are a Singapore SME lead researcher. Below is a verified list of BCA-registered construction companies in Singapore. All are confirmed real, active businesses. For each company, use your knowledge of Singapore businesses to fill in their decision-maker, recent growth signals (2024-2025), and likely AI automation pain points.

VERIFIED BCA-REGISTERED COMPANIES (do NOT add or remove any company):
${seedList}

BCA grade revenue guidance: C2 ≈ SGD 1–5M, B2 ≈ SGD 5–15M, B1 ≈ SGD 10–30M

For each company, return:
- company_name: EXACTLY as listed above
- sector: "Construction"
- estimated_revenue_sgd: based on BCA grade
- employee_count: estimate based on grade and any known signals
- website: use provided if known, otherwise your best knowledge
- recent_signal: any hiring activity, project wins, awards, news from 2024-2025 (be specific with numbers/dates if known; if unknown, note the BCA grade and years in operation as signal)
- decision_maker: name and title from LinkedIn, company website, or ACRA directors if known; use "Director" or "Managing Director" as fallback title only — include actual name if at all possible
- pain_point_inferred: specific to their construction type (e.g. HDB progress reports, MOM compliance, subcontractor scheduling, variation order tracking)
- confidence: 0-1

IMPORTANT: Return ONLY valid JSON array. Include ALL ${seeds.length} companies. No preamble.

[
  {
    "company_name": "Example Builders Pte Ltd",
    "sector": "Construction",
    "estimated_revenue_sgd": "SGD 3M",
    "employee_count": 40,
    "website": "example.com.sg",
    "recent_signal": "BCA CW01 C2 registered since 1995; 3 site supervisor hires on MyCareersFuture Q1 2025",
    "decision_maker": "Tan Ah Kow, Managing Director",
    "pain_point_inferred": "Manual daily site diary and progress report submission to main contractors",
    "confidence": 0.75
  }
]`;
  } else {
    const queries = getSearchQueries(sector);
    const queryList = queries.map((q, i) => `${i + 1}. "${q}"`).join("\n");

    prompt = `You are a Singapore SME lead prospector. Find real companies matching these criteria:
- Sector: ${sector}
- Revenue: SGD 300K-5M estimated (small to mid-sized, resource-constrained businesses)
- Employees: 5-200
- Recent signal: growth challenges, hiring struggles, manual process pain, or early tech adoption in 2024-2025
- Target profile: owner-operated or lean-team businesses that need affordable AI, NOT well-funded startups or large enterprises

PREFERRED SOURCES (in priority order):
1. Singapore Business Federation (SBF) member directory — sbf.org.sg/members — prioritise listed companies
2. Accounting and Corporate Regulatory Authority (ACRA) registered companies with active operations
3. LinkedIn Singapore company pages with recent hiring activity
4. News coverage from The Business Times, CNA, or e27 from 2024-2025

SEARCH QUERIES TO TRY:
${queryList}

For each company found, extract (via your knowledge of Singapore businesses):
- Company name
- Sector
- Estimated revenue (SGD)
- Employee count estimate
- Website
- Recent signal (news/hiring/funding — be SPECIFIC with numbers/dates)
- Visible decision-maker name & title (Founder/CEO for <50 emp, COO/VP Ops for larger)
- Pain point inferred (specific, not generic)
- Confidence (0-1)

Return as JSON array. Prioritize companies with signals from last 12 months.
Find at least 5 companies. Maximum 12.

IMPORTANT: Return ONLY valid JSON array, no preamble or explanation.

[
  {
    "company_name": "XYZ Corp",
    "sector": "Manufacturing",
    "estimated_revenue_sgd": "SGD 25M",
    "employee_count": 150,
    "website": "xyz.com.sg",
    "recent_signal": "Hired 20 operations staff in Q3 2024",
    "decision_maker": "John Tan, COO",
    "pain_point_inferred": "Scaling operations without proportional headcount growth",
    "confidence": 0.85
  }
]`;
  }

  const response = await callWithRetry(() =>
    client.messages.create({
      model: MODEL,
      max_tokens: seeds.length > 0 ? 8000 : 3000,
      messages: [{ role: "user", content: prompt }],
    })
  );

  const text = response.content[0]?.text || "";
  const companies = parseJSON(text);

  if (!Array.isArray(companies)) {
    console.error("Prospector returned non-array result");
    return [];
  }

  console.log(`✅ Found ${companies.length} companies`);
  return companies;
}

// AGENT 1.5: SME VERIFIER
async function verifySMEStatus(company) {
  const prompt = `Search online for "${company.company_name}" Singapore.
Find their latest annual revenue, total funding raised, or ACRA paid-up capital in SGD.
Set discard=true if any verified metric exceeds SGD 5,000,000.
If no data found online, set discard=false and note "unverified".

Return ONLY valid JSON, no other text:
{
  "company_name": "${company.company_name}",
  "revenue_sgd": <number or null>,
  "funding_sgd": <number or null>,
  "paid_up_capital_sgd": <number or null>,
  "discard": <true or false>,
  "reason": "<brief explanation>"
}`;

  const response = await callWithRetry(() =>
    client.messages.create(
      {
        model: MODEL,
        max_tokens: 800,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: prompt }],
      },
      { headers: { "anthropic-beta": "web-search-2025-03-05" } }
    )
  );

  const textBlock = response.content.find((b) => b.type === "text");
  const result = parseJSON(textBlock?.text || "");
  return result || { company_name: company.company_name, discard: false, reason: "could not verify — keeping" };
}

// AGENT 2: FIT ASSESSMENT
async function assessCompanyFit(company) {
  const prompt = `Evaluate fit for AI consultancy services (multi-agent systems, process automation, customer AI).

Company:
${JSON.stringify(company, null, 2)}

Score on 5 dimensions (0-1 each):
1. Revenue Stage (10% weight): Budget for affordable AI (SGD 3K-25K engagement)? SGD 300K-1M=0.7, SGD 1M-5M=0.9, below 300K=0.3, above 5M=0.1
2. Tech Maturity (25%): Hiring AI/ML=1.0, Modern stack=0.85, No tech hiring 2yrs=0.2
3. Automation Readiness (30%): Ops surge without automation=1.0, Public complaints=0.95, Already automated=0.3
4. Customer AI Readiness (10%): B2C/SaaS/E-comm=0.95, Mixed B2B2C=0.7, Pure B2B small count=0.2
5. Multi-Agent Fit (25%): Cross-dept workflows=1.0, Supply chain coord=0.95, Single simple task=0.15

Formula: overall = 0.10*revenue + 0.25*tech + 0.30*automation + 0.10*customer + 0.25*multi_agent
Apply red flag penalties (already deployed AI competitor = PASS) and green flag bonuses (recent funding +0.1, rapid hiring +0.15).

Decision: 0-0.3=PASS, 0.3-0.5=NURTURE, 0.5-0.7=FOLLOW_UP, 0.7-0.85=PRIORITIZE, 0.85-1.0=URGENT

Return ONLY valid JSON:
{
  "company_name": "...",
  "overall_fit_score": 0.75,
  "revenue_stage_score": 0.85,
  "tech_maturity_score": 0.7,
  "automation_readiness_score": 0.9,
  "customer_ai_readiness_score": 0.6,
  "multi_agent_fit_score": 0.8,
  "primary_service_fit": "process_automation",
  "key_opportunity": "...",
  "recommendation": "PRIORITIZE",
  "reasoning": "..."
}`;

  const response = await callWithRetry(() =>
    client.messages.create({
      model: MODEL,
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    })
  );

  const text = response.content[0]?.text || "";
  const fit = parseJSON(text);
  return fit || { company_name: company.company_name, overall_fit_score: 0, recommendation: "PASS" };
}

// AGENT 3: OUTREACH GENERATION
async function generateOutreach(company, fitAssessment) {
  const decisionMaker = company.decision_maker || "the founder";
  const firstName = decisionMaker.split(",")[0].split(" ")[0];

  const prompt = `Write a personalized cold email to ${decisionMaker} at ${company.company_name}.

Context:
- Company: ${company.company_name} (${company.sector})
- What caught our attention: ${company.recent_signal}
- Inferred pain point: ${company.pain_point_inferred}
- Our recommended service: ${fitAssessment.primary_service_fit}
- Key opportunity: ${fitAssessment.key_opportunity}
- Decision-maker first name: ${firstName}

Email rules:
1. Open with a SPECIFIC fact about their company (not generic)
2. Reference the signal we noticed (exact numbers/events)
3. Name one exact problem it signals
4. Propose our service as the solution (be specific to their sector)
5. Micro-offer: "15-minute discovery call" or "2-page automation audit"
6. Use first name only (${firstName})
7. Keep it 3-4 sentences body + signature
8. Consultant tone (peer-to-peer, not salesy)
9. Include a compelling subject line

Format output as:
SUBJECT: [subject line]

[email body]

Signature:
Hon Mun
Aixer Solutions | hmchan@aixers.com`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 600,
    messages: [{ role: "user", content: prompt }],
  });

  return response.content[0]?.text || "";
}

// MAIN WORKFLOW
async function runDailyProspecting() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("🤖 DAILY AI PROSPECTING WORKFLOW — Aixer Solutions");
  console.log("═══════════════════════════════════════════════════════════");

  const sector = selectTodaysSector();
  console.log(`📅 Today's sector focus: ${sector}`);
  console.log(`🤖 Model: ${MODEL}`);

  // PHASE 1: PROSPECT
  let companies = [];
  try {
    companies = await runProspectorAgent(sector);
  } catch (err) {
    console.error("❌ Prospector failed:", err.message);
    return;
  }

  if (companies.length === 0) {
    console.log("❌ No companies found. Check search queries in 20_SEARCH_MATRIX.json.");
    return;
  }

  // PHASE 1.5: SME VERIFICATION
  console.log(`\n🔎 SME VERIFICATION: Cross-checking ${companies.length} companies online...\n`);
  const verified = [];
  for (const company of companies) {
    try {
      const v = await verifySMEStatus(company);
      if (v.discard) {
        console.log(`  ✗ ${company.company_name}: REMOVED — ${v.reason}`);
      } else {
        console.log(`  ✓ ${company.company_name}: PASSES — ${v.reason || "under $3M SGD threshold"}`);
        verified.push(company);
      }
    } catch (err) {
      console.error(`  ? ${company.company_name}: verification error — ${err.message}, keeping`);
      verified.push(company);
    }
    await sleep(12000);
  }
  companies = verified;

  if (companies.length === 0) {
    console.log("❌ No companies passed SME verification.");
    return;
  }
  console.log(`\n✅ ${companies.length} companies passed SME verification`);

  // PHASE 2: ASSESS
  console.log(`\n🎯 FIT ASSESSMENT: Evaluating ${companies.length} companies...\n`);
  const scored = [];
  for (const company of companies) {
    try {
      const fit = await assessCompanyFit(company);
      scored.push({ ...company, ...fit });
      const score = fit.overall_fit_score?.toFixed(2) ?? "err";
      const rec = fit.recommendation ?? "?";
      console.log(`  ${company.company_name}: ${score} → ${rec}`);
    } catch (err) {
      console.error(`  ${company.company_name}: assessment error — ${err.message}`);
      scored.push({ ...company, overall_fit_score: 0, recommendation: "PASS" });
    }
    await sleep(3000);
  }

  // PHASE 3: RANK & FILTER
  scored.sort((a, b) => (b.overall_fit_score || 0) - (a.overall_fit_score || 0));
  const qualified = scored.filter((s) => (s.overall_fit_score || 0) > 0.5);
  console.log(`\n✅ Qualified leads (fit > 0.5): ${qualified.length}`);

  // PHASE 4: OUTREACH
  const outreachResults = [];
  if (qualified.length > 0) {
    const maxEmails = CONFIG.outreach?.max_emails_per_run || 5;
    console.log(`\n📧 GENERATING OUTREACH (Top ${maxEmails}):\n`);
    for (let i = 0; i < Math.min(maxEmails, qualified.length); i++) {
      const lead = qualified[i];
      console.log(`\n─ ${i + 1}. ${lead.company_name} (Fit: ${lead.overall_fit_score?.toFixed(2)})`);
      try {
        const email = await generateOutreach(lead, lead);
        console.log(email);
        console.log("\n[REVIEW BEFORE SENDING]");
        outreachResults.push({ company: lead.company_name, email });
      } catch (err) {
        console.error(`  Email generation failed: ${err.message}`);
      }
    }
  }

  // PHASE 5: SAVE OUTPUT
  const dateStr = new Date().toISOString().split("T")[0];
  const timestamp = new Date().toISOString().replace(/:/g, "-").split(".")[0];
  const outputFile = new URL(`./output/prospecting_${timestamp}.json`, import.meta.url).pathname;

  const output = {
    date: new Date().toISOString(),
    sector,
    model: MODEL,
    total_companies_found: companies.length,
    qualified_leads: qualified.map((q) => ({
      company_name: q.company_name,
      sector: q.sector,
      fit_score: q.overall_fit_score,
      recommendation: q.recommendation,
      opportunity: q.key_opportunity,
      decision_maker: q.decision_maker,
      website: q.website,
      recent_signal: q.recent_signal,
    })),
    all_scored: scored.map((s) => ({
      company_name: s.company_name,
      fit_score: s.overall_fit_score,
      recommendation: s.recommendation,
    })),
    outreach_emails: outreachResults,
  };

  try {
    fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));
    console.log(`\n✅ Results saved to ${outputFile}`);
  } catch (err) {
    console.error("Could not save output file:", err.message);
  }

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log(`📊 Summary: ${companies.length} found → ${qualified.length} qualified → ${outreachResults.length} emails generated`);
  console.log("═══════════════════════════════════════════════════════════\n");
}

runDailyProspecting().catch(console.error);
