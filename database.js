const mongoose = require('mongoose');

const noticeSchema = new mongoose.Schema({
    noticeId: { type: String, required: true, unique: true },
    title: { type: String, required: true },
    date: { type: String, required: true },
    url: { type: String },
    sentAt: { type: Date, default: Date.now }
});

const Notice = mongoose.model('Notice', noticeSchema);
async function connectDB(uri) {
    // console.log(uri);
    if (!uri) {
        throw new Error('MONGO_URI is not defined in environment variables.');
    }

    try {
        await mongoose.connect(uri, { family: 4 });
        console.log('📦 MongoDB Connected Successfully');
    } catch (error) {
        console.error('❌ MongoDB Connection Failed:', error.message);
        throw error;
    }
}

async function disconnectDB() {
    await mongoose.disconnect();
    console.log('📦 MongoDB Disconnected');
}

module.exports = { Notice, connectDB, disconnectDB };
