const { NoticeMonitor, ContentFilterStrategy, TimeFilterStrategy } = require('./index'); // We need to export these from index.js first!
const { Notice } = require('./database');

// MOCK DATA
const MOCK_NOTICES = {
    BEST_CASE: [
        {
            id: '99999',
            title: 'Urgent: Exam Form for B.Tech VI Sem (Main) 2025',
            date: new Date().toISOString(), // TODAY
            content: 'download/form_vi_sem.pdf'
        }
    ],
    WORST_CASE: [
        {
            id: '88888',
            title: 'Holiday Notice: Holi Festival',
            date: new Date().toISOString(),
            content: 'download/holi.pdf'
        },
        {
            id: '77777',
            title: 'Exam Form for B.Tech I Sem (Back)',
            date: new Date().toISOString(),
            content: 'download/back_i_sem.pdf'
        }
    ]
};

// MOCK STRATEGIES
class MockPersistenceStrategy {
    constructor() {
        this.sentIds = new Set();
    }
    async init() { console.log('MockDB: Connected'); }
    async preload(notices) { console.log('MockDB: Preloaded 0 IDs'); }
    async check(notice) { return !this.sentIds.has(String(notice.id)); }
    async saveSentNotices(notices) {
        notices.forEach(n => this.sentIds.add(String(n.id)));
        console.log(`MockDB: Saved ${notices.length} notices.`);
    }
    async cleanup() { console.log('MockDB: Disconnected'); }
}

class MockMonitor extends NoticeMonitor {
    constructor(scenario) {
        // strategies same as index.js logic now
        const strategies = [
            new TimeFilterStrategy(),
            new MockPersistenceStrategy()
            // NO ContentFilterStrategy here anymore!
        ];
        super(strategies, strategies[1]);
        this.scenario = scenario;
    }

    // OVERRIDE fetchNotices to return MOCK data
    async fetchNotices() {
        console.log(`\n--- SIMULATING SCENARIO: ${this.scenario} ---`);
        return MOCK_NOTICES[this.scenario] || [];
    }

    // OVERRIDE sendEmail to avoid spamming real email
    async sendEmail(notices) {
        console.log(`📧 [MOCK EMAIL] Sending ${notices.length} alerts:`);

        // REPLICATING index.js logic for mock subject line check
        const contentFilter = new ContentFilterStrategy();
        let hasCritical = false;

        for (const n of notices) {
            if (await contentFilter.check(n)) hasCritical = true;
        }

        const subject = hasCritical
            ? "🚨 CRITICAL: 6th Sem Exam Notice Detected!"
            : "📢 New College Notice(s) Released";

        console.log(`   - Subject: ${subject}`);
    }
}

async function runSimulation() {
    process.env.TEST_MODE = 'false'; // Simulate PROD
    console.log("⚡ STARTING SIMULATIONS...");

    // 1. WORST CASE: Irrelevant notices
    const worstCase = new MockMonitor('WORST_CASE');
    await worstCase.run();

    // 2. BEST CASE: Target notice found
    const bestCase = new MockMonitor('BEST_CASE');
    await bestCase.run();
}

runSimulation();
