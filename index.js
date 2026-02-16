require('dotenv').config();
const axios = require('axios');
const { Resend } = require('resend');
const { Notice, connectDB, disconnectDB } = require('./database');

const Config = {
    NEWS_API: cleanUrl(process.env.COLLEGE_NEWS_API),
    EXAM_API: cleanUrl(process.env.COLLEGE_EXAM_API),
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    EMAIL_TO: process.env.EMAIL_TO,
    EMAIL_FROM: process.env.EMAIL_FROM,
    MONGO_URI: process.env.MONGO_URI,
    // Strict comparison for the string "true"
    TEST_MODE: process.env.TEST_MODE === 'true',
    SEED_MODE: process.env.SEED_MODE === 'true',
    NOTICE_AGE_LIMIT_HOURS: parseInt(process.env.NOTICE_AGE_LIMIT_HOURS || '24', 10)
};

function cleanUrl(url) {
    return url ? url.replace(/['"\s]/g, '') : '';
}

class TimeFilterStrategy {
    constructor() {
        const hours = Config.NOTICE_AGE_LIMIT_HOURS;
        this.cutoffDate = new Date(Date.now() - hours * 60 * 60 * 1000);
    }

    async check(notice) {
        return new Date(notice.date) >= this.cutoffDate;
    }
}

class ContentFilterStrategy {
    constructor() {
        this.CRITICAL_PATTERNS = [
            /BTU.*Exam.*Form.*VI\s*Sem/i,
            /B\.?Tech.*(6th|VI\b|Sixth)\s*Sem/i,
            /Even\s*Sem.*Exam/i,
            /(Exam|Form|Fee).*?(6th|VI\b|Sixth)/i,
        ];
        this.GENERIC_EXAM_FORM = /Exam.*Form/i;
        this.EXCLUDE_SEMESTERS = /(1st|3rd|5th|7th|I\s*Sem|III\s*Sem|V\s*Sem|VII\s*Sem)/i;
    }

    async check(notice) {
        const title = notice.title;
        const explicitMatch = this.CRITICAL_PATTERNS.some(regex => regex.test(title));
        const isGenericUrgent = this.GENERIC_EXAM_FORM.test(title) && !this.EXCLUDE_SEMESTERS.test(title);

        if (explicitMatch || isGenericUrgent) {
            return true;
        }
        return false;
    }
}

class MongoPersistenceStrategy {
    constructor() {
        this.existingIds = new Set();
    }

    async init() {
        await connectDB(Config.MONGO_URI);
    }

    async preload(notices) {
        if (notices.length === 0) return;
        const idsToCheck = notices.map(n => String(n.id));
        const existingDocs = await Notice.find({ noticeId: { $in: idsToCheck } }).select('noticeId');
        this.existingIds = new Set(existingDocs.map(doc => String(doc.noticeId)));
    }

    async check(notice) {
        return !this.existingIds.has(String(notice.id));
    }

    async saveSentNotices(notices) {
        if (notices.length === 0) return;

        const operations = notices.map(n => ({
            noticeId: String(n.id),
            title: n.title,
            date: n.date,
            url: n.content
        }));

        try {
            await Notice.insertMany(operations, { ordered: false });
            notices.forEach(n => this.existingIds.add(String(n.id)));
        } catch (error) {
            console.error('⚠️ Error saving to DB:', error.message);
        }
    }

    async cleanup() {
        await disconnectDB();
    }
}

class NoticeMonitor {
    constructor(strategies, persistenceStrategy) {
        this.strategies = strategies;
        this.persistence = persistenceStrategy;
        this.resend = new Resend(Config.RESEND_API_KEY);
    }

    async run() {
        try {
            if (this.persistence) {
                await this.persistence.init();
            }

            let uniqueNotices = await this.fetchNotices();

            uniqueNotices.sort((a, b) => new Date(a.date) - new Date(b.date));

            if (this.persistence) {
                await this.persistence.preload(uniqueNotices);
            }

            if (Config.SEED_MODE) {
                console.log('🌱 SEED MODE ACTIVE: Populating database baseline...');
                const noticesToSeed = uniqueNotices.filter(n => !this.persistence.existingIds.has(String(n.id)));

                if (noticesToSeed.length > 0) {
                    await this.persistence.saveSentNotices(noticesToSeed);
                    console.log(`✅ Seeding Complete. ${noticesToSeed.length} baseline records created.`);
                } else {
                    console.log('✅ Baseline already exists. No new records to seed.');
                }
                return;
            }

            const relevantNotices = await this.applyFilters(uniqueNotices);

            if (relevantNotices.length > 0) {
                // We send email for ALL new notices, but subject line differs
                await this.sendEmail(relevantNotices);

                if (this.persistence && !Config.TEST_MODE) {
                    await this.persistence.saveSentNotices(relevantNotices);
                } else if (Config.TEST_MODE) {
                    console.log('⚠️ TEST MODE: Not saving to DB.');
                }
            } else {
                console.log('✅ No new notices to process.');
            }

        } catch (error) {
            console.error('❌ Critical Error:', error.message);
            process.exit(1);
        } finally {
            if (this.persistence) {
                await this.persistence.cleanup();
            }
        }
    }

    async fetchNotices() {
        const [newsResponse, examResponse] = await Promise.all([
            axios.get(Config.NEWS_API),
            axios.get(Config.EXAM_API)
        ]);

        const allNotices = [...(newsResponse.data.data || []), ...(examResponse.data.data || [])];
        return Array.from(new Map(allNotices.map(item => [item.id, item])).values());
    }

    async applyFilters(notices) {
        const results = [];
        for (const notice of notices) {
            let keep = true;
            for (const strategy of this.strategies) {
                const result = await strategy.check(notice);
                if (!result) {
                    keep = false;
                    break;
                }
            }
            if (keep) {
                results.push(notice);
            }
        }
        return results;
    }

    async sendEmail(notices) {
        // Classify Notices for Subject Line
        const contentFilter = new ContentFilterStrategy(); // Used for classification now
        let hasCritical = false;

        const noticeHtmlPromises = notices.map(async n => {
            const isCritical = await contentFilter.check(n);
            if (isCritical) hasCritical = true;

            const borderColor = isCritical ? '#ef4444' : '#3b82f6'; // Red vs Blue
            const bgColor = isCritical ? '#fef2f2' : '#eff6ff';
            const titleColor = isCritical ? '#991b1b' : '#1e40af';
            const btnColor = isCritical ? '#dc2626' : '#2563eb';

            return `
            <div style="border: 2px solid ${borderColor}; background-color: ${bgColor}; padding: 15px; margin-bottom: 15px; border-radius: 8px;">
                <h3 style="margin: 0 0 10px 0; color: ${titleColor};">${isCritical ? '🚨 ' : ''}${n.title}</h3>
                <p><strong>Date:</strong> ${n.date} <span style="color: #666;">(ID: ${n.id})</span></p>
                <a href="https://ecajmer.ac.in/${n.content}" style="background-color: ${btnColor}; color: white; padding: 10px 15px; text-decoration: none; border-radius: 5px; font-weight: bold;">
                    DOWNLOAD PDF
                </a>
            </div>
            `;
        });

        const noticeHtml = (await Promise.all(noticeHtmlPromises)).join('');

        const subject = hasCritical
            ? `${Config.TEST_MODE ? '[TEST] ' : ''}🚨 CRITICAL: 6th Sem Exam Notice Detected!`
            : `${Config.TEST_MODE ? '[TEST] ' : ''}📢 New College Notice(s) Released`;

        try {
            const { data, error } = await this.resend.emails.send({
                from: Config.EMAIL_FROM,
                to: [Config.EMAIL_TO],
                subject: subject,
                html: `
                    <h2>${hasCritical ? '⚠️ Important Exam Notice Found' : 'ℹ️ New Notices'}</h2>
                    ${Config.TEST_MODE ? '<p style="color:orange;">This is a TEST run searching past data.</p>' : ''}
                    ${noticeHtml}
                `
            });

            if (error) {
                console.error('❌ Resend API Error:', error);
                throw new Error(`Email sending failed: ${error.message}`);
            }

            console.log('📧 Email sent successfully!', data);
        } catch (error) {
            console.error('❌ Email Failure:', error);
            throw error;
        }
    }
}

// --- EXECUTION ---
// Only run if called directly (not imported)
if (require.main === module) {
    const strategies = [];
    const mongoPersistence = new MongoPersistenceStrategy();

    if (!Config.TEST_MODE) {
        strategies.push(new TimeFilterStrategy());
        strategies.push(mongoPersistence);
    } else {
        console.log("⚠️ TEST MODE: Skipping 24h filter and DB check...");
    }

    // REMOVED: strategies.push(new ContentFilterStrategy()); 
    // We now fetch ALL new notices and classify them in sendEmail

    const monitor = new NoticeMonitor(strategies, mongoPersistence);
    monitor.run();
}

module.exports = { NoticeMonitor, ContentFilterStrategy, TimeFilterStrategy, MongoPersistenceStrategy, Config };