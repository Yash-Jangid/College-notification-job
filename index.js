require('dotenv').config();
const axios = require('axios');
const { Resend } = require('resend');

// Helper to clean dirty env vars (quotes, spaces)
const cleanUrl = (url) => (url ? url.replace(/['"\s]/g, '') : '');

// --- CONFIGURATION ---
const NEWS_API = cleanUrl(process.env.COLLEGE_NEWS_API);
const EXAM_API = cleanUrl(process.env.COLLEGE_EXAM_API);

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_TO = process.env.EMAIL_TO;
const EMAIL_FROM = process.env.EMAIL_FROM;

// --- TEST MODE SWITCH ---
// Set this to TRUE to ignore date checks and force an email if ANY match is found in history.
// Set this to FALSE for daily production use (only checks last 24h).
const TEST_MODE = process.env.TEST_MODE || false;

// --- ROBUST FILTERING LOGIC ---
const CRITICAL_PATTERNS = [
    /BTU.*Exam.*Form.*VI\s*Sem/i,
    /B\.?Tech.*(6th|VI\b|Sixth)\s*Sem/i,
    /Even\s*Sem.*Exam/i,
    /(Exam|Form|Fee).*?(6th|VI\b|Sixth)/i,
];

const GENERIC_EXAM_FORM = /Exam.*Form/i;
const EXCLUDE_SEMESTERS = /(1st|3rd|5th|7th|I\s*Sem|III\s*Sem|V\s*Sem|VII\s*Sem)/i;

const resend = new Resend(RESEND_API_KEY);

async function checkNews() {
    try {
        console.log(`🔍 Status: Starting check in ${TEST_MODE ? 'TEST MODE' : 'PRODUCTION MODE'}...`);

        // 1. Fetch both APIs in parallel
        const [newsResponse, examResponse] = await Promise.all([
            axios.get(NEWS_API),
            axios.get(EXAM_API)
        ]);

        const newsData = newsResponse.data.data || [];
        const examData = examResponse.data.data || [];

        // Combine and remove duplicates (based on ID)
        const allNotices = [...newsData, ...examData];
        const uniqueNotices = Array.from(new Map(allNotices.map(item => [item.id, item])).values());

        console.log(`✅ Fetched ${uniqueNotices.length} unique notices.`);

        // 2. Filter: Time Check (Last 24 Hours)
        // SKIPPED if TEST_MODE is true
        const today = new Date();
        const oneDayAgo = new Date(today.getTime() - (24 * 60 * 60 * 1000));

        let recentCirculars = uniqueNotices;
        if (!TEST_MODE) {
            recentCirculars = uniqueNotices.filter(item => new Date(item.date) >= oneDayAgo);
        } else {
            console.log("⚠️ TEST MODE: Skipping 24h filter to find historical matches...");
        }

        if (recentCirculars.length === 0) {
            console.log('✅ No new notices to process.');
            return;
        }

        // 3. Filter: Keyword/Pattern Matching
        const relevantNotices = recentCirculars.filter(item => {
            const title = item.title;
            const explicitMatch = CRITICAL_PATTERNS.some(regex => regex.test(title));
            const isGenericUrgent = GENERIC_EXAM_FORM.test(title) && !EXCLUDE_SEMESTERS.test(title);

            if (explicitMatch || isGenericUrgent) {
                console.log(`🚨 MATCH FOUND: ${title}`);
                return true;
            }
            return false;
        });

        if (relevantNotices.length > 0) {
            await sendEmail(relevantNotices);
        } else {
            console.log('ℹ️ No matching "6th Sem" notices found.');
        }

    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1); // Fail the workflow so it's red in GHA
    }
}

async function sendEmail(notices) {
    const noticeHtml = notices.map(n => `
        <div style="border: 2px solid #ef4444; background-color: #fef2f2; padding: 15px; margin-bottom: 15px; border-radius: 8px;">
            <h3 style="margin: 0 0 10px 0; color: #991b1b;">${n.title}</h3>
            <p><strong>Date:</strong> ${n.date} <span style="color: #666;">(ID: ${n.id})</span></p>
            <a href="https://ecajmer.ac.in/${n.content}" style="background-color: #dc2626; color: white; padding: 10px 15px; text-decoration: none; border-radius: 5px; font-weight: bold;">
                DOWNLOAD PDF
            </a>
        </div>
    `).join('');

    try {
        await resend.emails.send({
            from: EMAIL_FROM,
            to: [EMAIL_TO],
            subject: `${TEST_MODE ? '[TEST] ' : ''}🚨 CRITICAL: 6th Sem Exam Notice Detected!`,
            html: `
                <h2>⚠️ Important Exam Notice Found</h2>
                ${TEST_MODE ? '<p style="color:orange;">This is a TEST run searching past data.</p>' : ''}
                ${noticeHtml}
            `
        });
        console.log('📧 Email sent successfully!');
    } catch (error) {
        console.error('Email failed:', error);
    }
}

checkNews();