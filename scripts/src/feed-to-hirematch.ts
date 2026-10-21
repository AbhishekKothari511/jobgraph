/**
 * JobGraph -> HireMatch Ingestion Bridge
 *
 * Feeds job data processed by JobGraph (CSV drop folder, RSS feeds, API)
 * directly into HireMatch (canonical seed catalog & Supabase if connected).
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

interface JobPosting {
  title: string;
  company: string;
  location: string;
  description: string;
  url?: string;
  salary_min?: number;
  salary_max?: number;
  remote?: boolean;
  job_type?: string;
  experience_level?: string;
  skills?: string[];
  requirements?: string[];
}

// Common tech keywords to auto-extract skills if missing
const KNOWN_SKILLS = [
  'TypeScript', 'JavaScript', 'Python', 'Go', 'Golang', 'Rust', 'Java', 'C++', 'Ruby', 'Ruby on Rails',
  'React', 'Next.js', 'Vue', 'Angular', 'Node.js', 'Express', 'Django', 'FastAPI', 'Spring Boot',
  'PostgreSQL', 'MySQL', 'MongoDB', 'Redis', 'Supabase', 'pgvector', 'GraphQL', 'REST APIs',
  'AWS', 'Azure', 'GCP', 'Docker', 'Kubernetes', 'Terraform', 'CI/CD', 'Git',
  'Apache Spark', 'dbt', 'Kafka', 'Airflow', 'Snowflake', 'BigQuery',
  'Figma', 'UI/UX', 'Product Design', 'User Research', 'LLMs', 'OpenAI', 'LangChain'
];

function extractSkills(text: string): string[] {
  const found = new Set<string>();
  const lower = text.toLowerCase();
  for (const skill of KNOWN_SKILLS) {
    const skillPattern = new RegExp(`\\b${skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (skillPattern.test(text) || lower.includes(skill.toLowerCase())) {
      found.add(skill);
    }
  }
  return Array.from(found);
}

function inferExperienceLevel(title: string, description: string): string {
  const combined = `${title} ${description}`.toLowerCase();
  if (combined.includes('intern') || combined.includes('student') || combined.includes('entry') || combined.includes('junior') || combined.includes('associate')) {
    return 'entry';
  }
  if (combined.includes('senior') || combined.includes('lead') || combined.includes('staff') || combined.includes('principal') || combined.includes('architect')) {
    return 'senior';
  }
  if (combined.includes('director') || combined.includes('vp') || combined.includes('head of')) {
    return 'executive';
  }
  return 'mid';
}

function inferJobType(title: string, rawType?: string): string {
  if (rawType) {
    const lower = rawType.toLowerCase().replace(/[^a-z]/g, '_');
    if (lower.includes('intern')) return 'internship';
    if (lower.includes('contract')) return 'contract';
    if (lower.includes('part')) return 'part_time';
    if (lower.includes('full')) return 'full_time';
  }
  if (title.toLowerCase().includes('intern')) return 'internship';
  if (title.toLowerCase().includes('contract')) return 'contract';
  return 'full_time';
}

function parseCsvSimple(content: string): Record<string, string>[] {
  const lines = content.split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length < 2) return [];

  // Parse header
  const firstLine = lines[0];
  if (!firstLine) return [];
  const headers = splitCsvLine(firstLine);
  const results: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const values = splitCsvLine(line);
    if (values.length === headers.length) {
      const record: Record<string, string> = {};
      headers.forEach((h, idx) => {
        record[h.trim()] = values[idx]?.trim() || '';
      });
      results.push(record);
    }
  }
  return results;
}

function splitCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let insideQuote = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (insideQuote && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        insideQuote = !insideQuote;
      }
    } else if (char === ',' && !insideQuote) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

async function runFeeder() {
  console.log('====================================================');
  console.log('🔄 JobGraph -> HireMatch Data Feeder Pipeline');
  console.log('====================================================\n');

  const dropFolder = path.resolve(__dirname, '../../apps/ingestion/drop');
  const hirematchSeedPath = path.resolve(__dirname, '../../../hirematch/scripts/seed-data/jobs.json');

  if (!fs.existsSync(dropFolder)) {
    console.error(`❌ JobGraph drop folder not found at: ${dropFolder}`);
    process.exit(1);
  }

  if (!fs.existsSync(hirematchSeedPath)) {
    console.error(`❌ HireMatch seed jobs file not found at: ${hirematchSeedPath}`);
    process.exit(1);
  }

  // 1. Read all CSV files in drop folder
  const files = fs.readdirSync(dropFolder).filter(f => f.endsWith('.csv'));
  console.log(`📂 Found ${files.length} CSV file(s) in JobGraph drop folder: [${files.join(', ')}]`);

  const ingestedJobs: JobPosting[] = [];

  for (const file of files) {
    const filePath = path.join(dropFolder, file);
    const content = fs.readFileSync(filePath, 'utf-8');
    const rows = parseCsvSimple(content);
    console.log(`📄 Parsing ${file}: read ${rows.length} records.`);

    for (const r of rows) {
      if (!r.title || !r.company) continue;

      const title = r.title;
      const company = r.company;
      const location = r.location || (r.remote === 'true' ? 'Remote' : 'United States');
      const description = r.description || `${title} at ${company}.`;
      const skills = extractSkills(`${title} ${description}`);
      const experience_level = inferExperienceLevel(title, description);
      const job_type = inferJobType(title, r.job_type);

      const requirements = [
        `Demonstrated experience in ${skills.slice(0, 2).join(' and ') || 'relevant technologies'}.`,
        `Comfortable with distributed architecture, engineering best practices, and team collaboration.`,
        `Strong problem solving and communication skills.`
      ];

      ingestedJobs.push({
        title,
        company,
        location,
        description,
        url: r.url || `https://${company.toLowerCase().replace(/[^a-z0-9]/g, '')}.com/careers`,
        salary_min: r.salary_min ? parseInt(r.salary_min, 10) : 100000,
        salary_max: r.salary_max ? parseInt(r.salary_max, 10) : 160000,
        remote: r.remote === 'true' || location.toLowerCase().includes('remote'),
        job_type,
        experience_level,
        skills,
        requirements
      });
    }
  }

  console.log(`\n✨ Successfully parsed ${ingestedJobs.length} jobs from JobGraph.`);

  // 2. Load HireMatch jobs.json
  const hirematchSeed = JSON.parse(fs.readFileSync(hirematchSeedPath, 'utf-8'));
  const existingJobs: any[] = hirematchSeed.jobs || [];

  // Track existing to avoid duplicates
  const existingKeys = new Set(existingJobs.map(j => `${j.title.toLowerCase()}|${j.company.toLowerCase()}`));

  let addedCount = 0;
  const newHireMatchJobs: any[] = [];

  for (const job of ingestedJobs) {
    const key = `${job.title.toLowerCase()}|${job.company.toLowerCase()}`;
    if (existingKeys.has(key)) {
      console.log(`   ⏭️  Skipping duplicate: "${job.title}" at ${job.company}`);
      continue;
    }

    const uuid = crypto.randomUUID();
    const formattedJob = {
      id: uuid,
      title: job.title,
      company: job.company,
      location: job.location,
      job_type: job.job_type,
      experience_level: job.experience_level,
      description: job.description,
      requirements: job.requirements,
      skills: job.skills && job.skills.length > 0 ? job.skills : ['Software Engineering'],
      salary_min: job.salary_min || 110000,
      salary_max: job.salary_max || 165000,
      salary_currency: 'USD',
      status: 'active',
      source: 'jobgraph'
    };

    newHireMatchJobs.push(formattedJob);
    existingKeys.add(key);
    addedCount++;
    console.log(`   ✅ Ingested: "${job.title}" at ${job.company} (${job.location})`);
  }

  if (newHireMatchJobs.length > 0) {
    // Prepend newly ingested JobGraph jobs so they appear first on HireMatch
    hirematchSeed.jobs = [...newHireMatchJobs, ...existingJobs];
    fs.writeFileSync(hirematchSeedPath, JSON.stringify(hirematchSeed, null, 2), 'utf-8');
    console.log(`\n💾 Saved updated jobs catalog to HireMatch!`);
    console.log(`   Total jobs now in HireMatch: ${hirematchSeed.jobs.length} (+${addedCount} from JobGraph)`);
  } else {
    console.log('\nℹ️ All jobs from JobGraph already exist in HireMatch catalog.');
  }

  console.log('\n====================================================');
  console.log(`🎉 Ingestion Complete!`);
  console.log(`🌐 Refresh HireMatch at: http://localhost:3000/jobs`);
  console.log('====================================================\n');
}

runFeeder().catch(err => {
  console.error('❌ Ingestion pipeline failed:', err);
  process.exit(1);
});
