require('dotenv').config();
const os = require('os');
const dns = require('dns');
// Google DNS serverlarini o'rnatish (SRV record xatoliklarini oldini olish uchun)
try {
    dns.setServers(['8.8.8.8', '8.8.4.4']);
} catch (e) {
    console.log("DNS serverlarini o'zgartirib bo'lmadi, standart sozlamalar ishlatiladi.");
}

const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const { Api } = require("telegram/tl");
const mongoose = require('mongoose');
const express = require('express');

// --- SERVER UCHUN SOZLAMALAR (Render/Replit) ---
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('Bot is running!');
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
// ------------------------------------------------

// Bot tokeni
const token = process.env.BOT_TOKEN;

// API ma'lumotlari
const apiId = process.env.API_ID ? parseInt(process.env.API_ID) : 2040; 
const apiHash = process.env.API_HASH || "b18441a1ff607e10a989891a5462e627"; 

// Admin ID
const ADMIN_ID = process.env.ADMIN_ID ? parseInt(process.env.ADMIN_ID) : null;

// MongoDB Ulanish
const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
    console.error("❌ XATOLIK: .env faylda MONGO_URI yo'q! Iltimos, MongoDB URL manzilini kiriting.");
} else {
    mongoose.connect(MONGO_URI, {
        serverSelectionTimeoutMS: 5000,
        family: 4 // IPv4 ni majburlash
    })
        .then(() => console.log('✅ MongoDB ga ulandi!'))
        .catch(err => console.error('❌ MongoDB ulanish xatosi:', err));
}

// User Schema
const userSchema = new mongoose.Schema({
    chatId: { type: Number, required: true, unique: true },
    name: String,
    status: { type: String, default: 'pending' }, // pending, approved, blocked
    clicks: { type: Number, default: 0 },
    session: { type: String, default: null },
    joinedAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

// Botni yaratish
const bot = new TelegramBot(token, { polling: true });

// Foydalanuvchi holatlari
const userStates = {};
const reydSessions = {}; // Reyd sessiyalari
// Promise-larni saqlash uchun
const loginPromises = {};
// Userbot clients
const userClients = {};

// DB funksiyalari (MongoDB)
async function getUser(chatId) {
    try {

        return await User.findOne({ chatId });
    } catch (e) {
        console.error("DB o'qishda xatolik:", e);
        return null;
    }
}

async function getUsers() {
    try {
        return await User.find({});
    } catch (e) {
        console.error("DB o'qishda xatolik:", e);
        return [];
    }
}

async function updateUser(chatId, data) {
    try {
        return await User.findOneAndUpdate(
            { chatId },
            { $set: data },
            { new: true, upsert: true, setDefaultsOnInsert: true }
        );
    } catch (e) {
        console.error("DB yozishda xatolik:", e);
        return null;
    }
}

async function updateStats(chatId) {
    try {
        await User.findOneAndUpdate(
            { chatId },
            { $inc: { clicks: 1 } }
        );
    } catch (e) {
        console.error("Stats yangilashda xatolik:", e);
    }
}

// Bot komandalarini sozlash
    bot.setMyCommands([
        { command: '/start', description: 'Botni ishga tushirish' },
        { command: '/menu', description: 'Asosiy menyu' },
        { command: '/help', description: 'Yordam' }
    ]).catch(err => console.error("Komandalar sozlashda xatolik:", err));

    console.log(`Bot ishga tushdi (Host: ${os.hostname()})...`);
    
    // Adminlarga xabar berish (qaysi qurilmada yonayotganini bilish uchun)
    const adminIds = [process.env.ADMIN_ID, "5756088235", "6431709403", "1165182963"];
    adminIds.forEach(id => {
        if(id) {
             bot.sendMessage(id, `🚀 Bot ishga tushdi!\n💻 Host: ${os.hostname()}\n📅 Vaqt: ${new Date().toLocaleString()}`).catch(() => {});
        }
    });
if (!ADMIN_ID) {
    console.log("⚠️ DIQQAT: .env faylda ADMIN_ID ko'rsatilmagan.");
} else {
    console.log(`Admin ID sozlandi: ${ADMIN_ID}`);
}

// /start komandasi
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const name = msg.from.first_name;
    
    console.log(`User started: ${name} (${chatId})`);

    let user = await getUser(chatId);
    
    // Agar foydalanuvchi Admin bo'lsa, uni avtomatik 'approved' qilamiz
    if (chatId === ADMIN_ID) {
        if (!user) {
            user = await updateUser(chatId, { name, status: 'approved' });
            bot.sendMessage(chatId, "👋 Salom Admin! Tizimga xush kelibsiz.");
        } else if (user.status !== 'approved') {
            user = await updateUser(chatId, { status: 'approved' });
            bot.sendMessage(chatId, "👋 Salom Admin! Maqomingiz tiklandi.");
        }
    }

    if (!user) {
        // Yangi oddiy foydalanuvchi
        user = await updateUser(chatId, { name, status: 'pending' });
        
        bot.sendMessage(chatId, `👋 Assalomu alaykum, Hurmatli **${name}**!\n\n⚠️ Siz botdan foydalanish uchun botning oylik tulovini amalga oshirmagansiz.\n⚠️ Botdan foydalanish uchun admin orqali tulov qiling !!!\n\n👨‍💼 Admin: @ortiqov_x7`, {
            parse_mode: "Markdown"
        });
        
        // Adminga xabar berish
        bot.sendMessage(ADMIN_ID, `🆕 **Yangi foydalanuvchi ro'yxatdan o'tdi!**\n👤 Ism: ${name}\n🆔 ID: \`${chatId}\`\nStatus: Pending (Tasdiqlash kutilmoqda)\n/approve ${chatId} - Tasdiqlash\n/block ${chatId} - Bloklash`, {
            parse_mode: "Markdown"
        });
        return;
    }

    if (user.status === 'blocked') {
        bot.sendMessage(chatId, `👋 Assalomu alaykum, Hurmatli **${name}**!\n\n⚠️ Siz botdan foydalanish uchun botning oylik tulovini amalga oshirmagansiz.\n⚠️ Botdan foydalanish uchun admin orqali tulov qiling !!!\n\n👨‍💼 Admin: @ortiqov_x7`, { parse_mode: "Markdown" });
        return;
    }

    if (user.status === 'pending') {
        bot.sendMessage(chatId, `👋 Assalomu alaykum, Hurmatli **${name}**!\n\n⚠️ Siz botdan foydalanish uchun botning oylik tulovini amalga oshirmagansiz.\n⚠️ Botdan foydalanish uchun admin orqali tulov qiling !!!\n\n👨‍💼 Admin: @ortiqov_x7`, { parse_mode: "Markdown" });
        
        // Adminga qayta eslatma
        bot.sendMessage(ADMIN_ID, `⏳ **Foydalanuvchi hali ham kutmoqda!**\n👤 Ism: ${name}\n🆔 ID: \`${chatId}\`\nStatus: Pending\n/approve ${chatId} - Tasdiqlash`, {
            parse_mode: "Markdown"
        });
        return;
    }

    // Agar tasdiqlangan bo'lsa
    if (user.status === 'approved') {
        // Agar allaqachon sessiya bo'lsa
        if (user.session) {
             const clicks = user.clicks || 0;
             const mainMenu = {
                 reply_markup: {
                     keyboard: [
                         ["💎 Avto Almaz", "👤 AvtoUser"],
                         ["⚔️ Avto Reyd", "📣 Avto Reklama"],
                         ["📊 Profil", "🔄 Nomer almashtirish"],
                         ["🧾 Yordam"]
                     ],
                     resize_keyboard: true
                 }
             };

             bot.sendMessage(chatId, `👋 Assalomu alaykum, Hurmatli **${user.name}**!\n\n🤖 **Bu bot orqali siz:**\n• 💎 **Avto Almaz** - avtomatik almaz yig'ish\n• � **AvtoUser** - guruhdan foydalanuvchilarni yig'ish\n• 👮 **Admin ID** - guruh adminlarini aniqlash\n• 📣 **Avto Reklama** - foydalanuvchilarga reklama yuborish\n\nBotdan foydalanish uchun menudan tanlang!`, {
                 parse_mode: "Markdown",
                 ...mainMenu
             });
             
             // Userbotni qayta yuklash (agar o'chib qolgan bo'lsa)
             if (!userClients[chatId]) {
                 restoreUserSession(chatId, user.session);
             }
             return;
        }

        userStates[chatId] = { step: 'WAITING_PHONE' };
        
        // Eski promise-larni tozalash
        if (loginPromises[chatId]) {
            delete loginPromises[chatId];
        }

        bot.sendMessage(chatId, "✅ Siz tasdiqlangansiz.\n\nTelegram akkauntingizga kirish uchun **telefon raqamingizni** yuboring (masalan: `+998901234567`).", {
            parse_mode: "Markdown",
            reply_markup: { remove_keyboard: true }
        });
    }
});

// Admin komandalari
bot.onText(/\/approve (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (chatId !== ADMIN_ID) return;

    const targetId = parseInt(match[1]);
    const user = await getUser(targetId);

    if (user) {
        await updateUser(targetId, { status: 'approved' });
        bot.sendMessage(chatId, `✅ Foydalanuvchi ${targetId} tasdiqlandi.`);
        bot.sendMessage(targetId, "🎉 Siz admin tomonidan tasdiqlandingiz!\nEndi **/start** ni bosib ro'yxatdan o'tishingiz mumkin.", { parse_mode: "Markdown" });
    } else {
        bot.sendMessage(chatId, "❌ Foydalanuvchi topilmadi. U avval botga /start bosishi kerak.");
    }
});

bot.onText(/\/block (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (chatId !== ADMIN_ID) return;

    const targetId = parseInt(match[1]);
    const user = await getUser(targetId);

    if (user) {
        await updateUser(targetId, { status: 'blocked', session: null }); // Sessiyani o'chiramiz
        
        // Userbotni to'xtatish
        if (userClients[targetId]) {
            userClients[targetId].disconnect();
            delete userClients[targetId];
        }

        bot.sendMessage(chatId, `⛔️ Foydalanuvchi ${targetId} bloklandi va botdan uzildi.`);
        bot.sendMessage(targetId, `👋 Assalomu alaykum, Hurmatli **${user.name}**!\n\n⚠️ Siz botdan foydalanish uchun botning oylik tulovini amalga oshirmagansiz.\n⚠️ Botdan foydalanish uchun admin orqali tulov qiling !!!\n\n👨‍💼 Admin: @ortiqov_x7`, { parse_mode: "Markdown" });
    } else {
        bot.sendMessage(chatId, "❌ Foydalanuvchi topilmadi.");
    }
});

bot.onText(/\/stats/, async (msg) => {
    const chatId = msg.chat.id;
    if (chatId !== ADMIN_ID) return;

    const users = await getUsers();
    let message = "📊 **Statistika:**\n\n";
    let totalClicks = 0;

    users.forEach(u => {
        const clicks = u.clicks || 0;
        totalClicks += clicks;
        const statusIcon = u.status === 'approved' ? '✅' : (u.status === 'blocked' ? '⛔️' : '⏳');
        message += `👤 [${u.name}](tg://user?id=${u.chatId}) - ${statusIcon}\n`;
        message += `   🆔: \`${u.chatId}\`\n`;
        message += `   💎 Almazlar: ${clicks}\n\n`;
    });

    message += `----------\nJami foydalanuvchilar: ${users.length}\nJami almazlar: ${totalClicks}`;

    bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
});

bot.onText(/\/profile/, async (msg) => {
    const chatId = msg.chat.id;
    const user = await getUser(chatId);

    if (!user) {
        bot.sendMessage(chatId, "❌ Siz ro'yxatdan o'tmagansiz. /start ni bosing.");
        return;
    }

    const statusIcon = user.status === 'approved' ? '✅ Tasdiqlangan' : (user.status === 'blocked' ? '⛔️ Bloklangan' : '⏳ Kutilmoqda');
    
    let message = `👤 **Sizning Profilingiz:**\n\n`;
    message += `📛 Ism: ${user.name}\n`;
    message += `🆔 ID: \`${user.chatId}\`\n`;
    message += `📊 Holat: ${statusIcon}\n`;
    message += `💎 To'plangan almazlar: **${user.clicks || 0}** ta\n`;
    message += `📅 Ro'yxatdan o'tgan sana: ${new Date(user.joinedAt).toLocaleDateString()}\n`;

    bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
});

// /menu komandasi - Asosiy menyuni chiqarish
bot.onText(/\/menu/, async (msg) => {
    const chatId = msg.chat.id;
    const user = await getUser(chatId);

    if (user && user.session && user.status === 'approved') {
        const mainMenu = {
            reply_markup: {
                keyboard: [
                    ["💎 Avto Almaz", "👤 AvtoUser"],
                    ["⚔️ Avto Reyd", "📣 Avto Reklama"],
                    ["📊 Profil", "🔄 Nomer almashtirish"],
                    ["🧾 Yordam"]
                ],
                resize_keyboard: true
            }
        };
        bot.sendMessage(chatId, "📋 **Asosiy menyu:**", { parse_mode: "Markdown", ...mainMenu });
    } else {
        bot.sendMessage(chatId, "❌ Menyuni ochish uchun avval tizimga kiring (/start).");
    }
});

// /rek komandasi o'rniga "Avto Reklama" tugmasi ishlatiladi, lekin komanda ham qoladi
bot.onText(/\/rek/, async (msg) => {
    const chatId = msg.chat.id;
    const user = await getUser(chatId);

    if (!user || user.status !== 'approved' || !userClients[chatId]) {
        bot.sendMessage(chatId, "❌ Bu funksiyadan foydalanish uchun avval ro'yxatdan o'ting va hisobingizga kiring.");
        return;
    }

    userStates[chatId] = { step: 'WAITING_REK_USERS' };
    bot.sendMessage(chatId, "🚀 **Avto Reklama**\n\nIltimos, reklama yuboriladigan foydalanuvchilar username-larini yuboring.\n\n_Misol:_\n@user1\n@user2\n@user3\n\n(Maksimum 100 ta username)", { parse_mode: "Markdown" });
});


// Xabarlarni qayta ishlash (Login jarayoni)
bot.on('message', async (msg) => {
    try {
    const chatId = msg.chat.id;
    const text = msg.text || ''; // Xavfsizlik uchun: agar text yo'q bo'lsa, bo'sh satr olamiz

    // Agar text ham, stiker ham yo'q bo'lsa, chiqib ketamiz.
    // Lekin stiker bo'lsa, uni pastda (REYD_CONTENT da) ishlatamiz.
    if (!text && !msg.sticker) return;

    // --- MENYU TUGMALARI LOGIKASI ---
    // Strict match o'rniga includes ishlatamiz (ba'zan emoji ko'rinmay qolishi mumkin)
    const lowerText = text.toLowerCase();

    if (lowerText.includes("avto almaz")) {
        if (userStates[chatId]) delete userStates[chatId]; // State ni tozalash
        const user = await getUser(chatId);
        if (user && user.session) {
             const clicks = user.clicks || 0;
             bot.sendMessage(chatId, `💎 **Avto Almaz**\n\n✅ **Holat:** Faol\n💎 **Jami to'plangan:** ${clicks} ta\n\nBot avtomatik ravishda guruhlardagi 💎 tugmalarini bosib almaz yig'moqda.`, { parse_mode: "Markdown" });
        } else {
             bot.sendMessage(chatId, "❌ Bu bo'limga kirish uchun avval tizimga kiring (/start).");
        }
        return;
    }



    if (lowerText.includes("avtouser") || lowerText.includes("avto user")) {
        if (userStates[chatId]) delete userStates[chatId]; 
        const user = await getUser(chatId);
        
        // Login qilmagan bo'lsa
        if (!user || user.status !== 'approved' || !userClients[chatId]) {
            bot.sendMessage(chatId, "❌ **AvtoUser** ishlashi uchun avval hisobingizga kiring.\n\n/start ni bosing va telefon raqamingizni kiriting.", { parse_mode: "Markdown" });
            return;
        }

        userStates[chatId] = { step: 'WAITING_AVTOUSER_LINK' };
        bot.sendMessage(chatId, " Guruh linkini yubor:", { 
            parse_mode: "Markdown", 
            reply_markup: { remove_keyboard: true } 
        });
        return;
    }

    if (lowerText.includes("avto reyd")) {
        if (userStates[chatId]) delete userStates[chatId]; // State ni tozalash
        const user = await getUser(chatId);
        if (!user || user.status !== 'approved' || !userClients[chatId]) {
            bot.sendMessage(chatId, "❌ Bu funksiyadan foydalanish uchun avval ro'yxatdan o'ting va hisobingizga kiring.");
            return;
        }
        userStates[chatId] = { step: 'WAITING_REYD_TYPE' };
        bot.sendMessage(chatId, "⚔️ **Avto Reyd**\n\nNishon turini tanlang:", {
            parse_mode: "Markdown",
            reply_markup: {
                keyboard: [["👥 Guruh", "👤 User"], ["🔙 Bekor qilish"]],
                resize_keyboard: true,
                one_time_keyboard: true
            }
        });
        return;
    }

    if (lowerText.includes("avto reklama")) {
        if (userStates[chatId]) delete userStates[chatId]; // State ni tozalash
        const user = await getUser(chatId);
        if (!user || user.status !== 'approved' || !userClients[chatId]) {
            bot.sendMessage(chatId, "❌ Bu funksiyadan foydalanish uchun avval ro'yxatdan o'ting va hisobingizga kiring.");
            return;
        }
    
        userStates[chatId] = { step: 'WAITING_REK_USERS' };
        bot.sendMessage(chatId, "🚀 **Avto Reklama**\n\nIltimos, reklama yuboriladigan foydalanuvchilar username-larini yuboring.\n\n_Misol:_\n@user1\n@user2\n@user3\n\n(Maksimum 100 ta username)", { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } }); // Keyboardni vaqtincha olib tashlaymiz
        return;
    }

    if (lowerText.includes("profil")) {
        if (userStates[chatId]) delete userStates[chatId]; // State ni tozalash
        const user = await getUser(chatId);
        if (!user) {
            bot.sendMessage(chatId, "❌ Siz ro'yxatdan o'tmagansiz. /start ni bosing.");
            return;
        }
        const statusIcon = user.status === 'approved' ? '✅ Tasdiqlangan' : (user.status === 'blocked' ? '⛔️ Bloklangan' : '⏳ Kutilmoqda');
        let message = `👤 **Sizning Profilingiz:**\n\n`;
        message += `📛 Ism: ${user.name}\n`;
        message += `🆔 ID: \`${user.chatId}\`\n`;
        message += `📊 Holat: ${statusIcon}\n`;
        message += `💎 To'plangan almazlar: **${user.clicks || 0}** ta\n`;
        message += `📅 Ro'yxatdan o'tgan sana: ${new Date(user.joinedAt).toLocaleDateString()}\n`;
        bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
        return;
    }

    if (lowerText.includes("nomer almashtirish")) {
        if (userStates[chatId]) delete userStates[chatId]; // State ni tozalash
        const user = await getUser(chatId);
        if (user) {
            // Sessiyani o'chirish
            await updateUser(chatId, { session: null });
            
            // Clientni to'xtatish
            if (userClients[chatId]) {
                try {
                    userClients[chatId].disconnect();
                    userClients[chatId].destroy();
                    delete userClients[chatId];
                } catch (e) { console.error("Disconnect error:", e); }
            }
            
            // State ni tozalash
            if (userStates[chatId]) delete userStates[chatId];
            if (loginPromises[chatId]) delete loginPromises[chatId];

            bot.sendMessage(chatId, "🔄 **Tizimdan chiqildi.**\n\nBoshqa raqam bilan kirish uchun /start ni bosing.", { 
                parse_mode: "Markdown",
                reply_markup: { remove_keyboard: true } 
            });
        } else {
            bot.sendMessage(chatId, "❌ Siz tizimga kirmagansiz.");
        }
        return;
    }

    if (lowerText.includes("yordam")) {
        const helpText = "🧾 **Yordam**\n📌 **Funksiyalar:**\n\n💎 **Avto Almaz**\nGuruhlarda almazli tugmalarni avtomatik bosadi. Avto Almaz Knopkasida Bir marta bosish orqali almazlarni yig'ishni boshlaydi. Agar yana bir marta bosilsa almazlarni yig'ishni to'xtatadi.\n\n👤 **AvtoUser**\nGuruhdan foydalanuvchilarni yuserlarini yig'adi va sizga yuboradi maksimal 100 ta. 🔗 Guruh linki va limitni kiriting.\n\n⚔️ **Avto Reyd**\nTanlangan nishonga (Guruh yoki User) ko'rsatilgan miqdorda xabar yuboradi. Maksimal 500 ta xabar.\n\n📢 **Avto Reklama**\nSiz botga yuborgan 100 ta yuserga reklama yuboradi. Userlar va reklama matnini kiriting.\n\n📊 **Profil**\nSizning statistikangizni ko'rsatadi.\n\n🔄 **Nomer almashtirish**\nTelefon raqamingizni o'zgartirish.";
        bot.sendMessage(chatId, helpText, { parse_mode: "Markdown" });
        return;
    }

    if (text.startsWith('/')) return;

    // --- REYD CONTROL ---
    if (reydSessions[chatId]) {
        if (text === "⏹ To'xtatish") {
            reydSessions[chatId].status = 'stopped';
            bot.sendMessage(chatId, "🛑 Reyd to'xtatildi.", { reply_markup: { remove_keyboard: true } });
            // Session will be deleted in the loop when it sees 'stopped'
            return;
        }
        if (text === "⏸ Pauza") {
            reydSessions[chatId].status = 'paused';
            bot.sendMessage(chatId, "⏸ Reyd pauzada.", { 
                reply_markup: { 
                    keyboard: [["▶️ Davom ettirish", "⏹ To'xtatish"]],
                    resize_keyboard: true 
                } 
            });
            return;
        }
        if (text === "▶️ Davom ettirish") {
            reydSessions[chatId].status = 'active';
            bot.sendMessage(chatId, "▶️ Reyd davom ettirilmoqda...", { 
                reply_markup: { 
                    keyboard: [["⏸ Pauza", "⏹ To'xtatish"]],
                    resize_keyboard: true 
                } 
            });
            return;
        }
    }

    let state = userStates[chatId];
    if (!state) return;

    // Faqat tasdiqlangan userlar login qila oladi
    const user = await getUser(chatId);
    if (!user || user.status !== 'approved') return;

    // try {
        // --- REKLAMA LOGIKASI ---
        if (state.step === 'WAITING_REK_USERS') {
            const usernames = text.match(/@\w+/g);
            if (!usernames || usernames.length === 0) {
                bot.sendMessage(chatId, "❌ Hech qanday username topilmadi. Iltimos, qaytadan yuboring (masalan: @user1 @user2).");
                return;
            }

            if (usernames.length > 100) {
                bot.sendMessage(chatId, `❌ Maksimum 100 ta username mumkin. Siz ${usernames.length} ta yubordingiz.`);
                return;
            }

            state.rekUsers = usernames;
            state.step = 'WAITING_REK_TEXT';
            bot.sendMessage(chatId, `✅ **${usernames.length} ta** foydalanuvchi qabul qilindi.\n\nEndi reklama matnini yuboring:`, { parse_mode: "Markdown" });
            return;
        }

        if (state.step === 'WAITING_REK_TEXT') {
            state.rekText = text;
            state.step = 'WAITING_REK_CONFIRM';
            bot.sendMessage(chatId, `📜 **Reklama matni:**\n\n${text}\n\n👥 **Qabul qiluvchilar:** ${state.rekUsers.length} ta\n\nBoshlashni tasdiqlaysizmi? (Ha/Yo'q)`, {
                reply_markup: {
                    keyboard: [["Ha"], ["Yo'q"]],
                    one_time_keyboard: true,
                    resize_keyboard: true
                }
            });
            return;
        }

        if (state.step === 'WAITING_REK_CONFIRM') {
            if (text.toLowerCase() === 'ha') {
                bot.sendMessage(chatId, "🚀 Reklama yuborish boshlandi...", { reply_markup: { remove_keyboard: true } });
                delete userStates[chatId]; // State ni tozalaymiz, lekin jarayon davom etadi
                
                startReklama(chatId, userClients[chatId], state.rekUsers, state.rekText);
            } else {
                delete userStates[chatId];
                bot.sendMessage(chatId, "❌ Reklama bekor qilindi.", { reply_markup: { remove_keyboard: true } });
            }
            return;
        }



        // --- AVTOUSER YANGI LOGIKA ---
        if (state.step === 'WAITING_AVTOUSER_LINK') {
            const link = text.trim();
            // Link validatsiyasi (oddiy)
            if (link.length < 4) {
                bot.sendMessage(chatId, "❌ Iltimos, to'g'ri link yuboring.");
                return;
            }

            state.targetLink = link;
            state.step = 'WAITING_AVTOUSER_LIMIT';
            bot.sendMessage(chatId, "🔢 Nechta yig'ay? (max 1000)", { parse_mode: "Markdown" });
            return;
        }

        if (state.step === 'WAITING_AVTOUSER_LIMIT') {
            let limit = parseInt(text.replace(/\D/g, ''));
            if (isNaN(limit) || limit <= 0) limit = 100;
            if (limit > 2000) limit = 2000;

            bot.sendMessage(chatId, `⏳ **Jarayon boshlandi...**\n\n🔗 Guruh: ${state.targetLink}\n👥 Limit: ${limit}\n\nIltimos kuting, bu biroz vaqt olishi mumkin.`, { parse_mode: "Markdown" });

            // Asosiy funksiyani chaqirish
            startAvtoUser(chatId, userClients[chatId], state.targetLink, limit);
            
            delete userStates[chatId];
            return;
        }

        // --- AVTO REYD LOGIKASI ---
        if (state.step === 'WAITING_REYD_TYPE') {
            if (text === "👥 Guruh") {
                state.reydType = 'group';
                state.step = 'WAITING_REYD_TARGET';
                bot.sendMessage(chatId, "🔗 Guruh linkini yoki username-ni yuboring:", { reply_markup: { remove_keyboard: true } });
            } else if (text === "👤 User") {
                state.reydType = 'user';
                state.step = 'WAITING_REYD_TARGET';
                bot.sendMessage(chatId, "👤 Foydalanuvchi username-ni yuboring (@user):", { reply_markup: { remove_keyboard: true } });
            } else if (text === "🔙 Bekor qilish") {
                delete userStates[chatId];
                bot.sendMessage(chatId, "❌ Bekor qilindi. /menu orqali qaytishingiz mumkin.", { reply_markup: { remove_keyboard: true } });
            } else {
                 bot.sendMessage(chatId, "Iltimos, tugmalardan birini tanlang.");
            }
            return;
        }

        if (state.step === 'WAITING_REYD_TARGET') {
            // Agar foydalanuvchi link yuborsa, u tugma bosish deb o'ylanmasligi kerak
            state.target = text;
            state.step = 'WAITING_REYD_COUNT';
            bot.sendMessage(chatId, "🔢 Nechta xabar yuborish kerak? (Maksimal 500)");
            return;
        }

        if (state.step === 'WAITING_REYD_COUNT') {
            let count = parseInt(text);
            if (isNaN(count) || count <= 0) count = 10;
            if (count > 500) count = 500;
            state.count = count;
            state.step = 'WAITING_REYD_CONTENT';
            bot.sendMessage(chatId, "📝 Xabar matnini yuboring (Matn yoki Emoji):");
            return;
        }

        if (state.step === 'WAITING_REYD_CONTENT') {
            if (msg.sticker) {
                // Stikerni yuklab olamiz
                try {
                    const fileId = msg.sticker.file_id;
                    const tempDir = './temp';

                    // Temp papka borligini tekshirish
                    if (!fs.existsSync(tempDir)) {
                        fs.mkdirSync(tempDir, { recursive: true });
                    }
                    
                    // Bot API orqali yuklash
                    const savedPath = await bot.downloadFile(fileId, tempDir);
                    
                    state.content = savedPath; // To'liq path
                    state.contentType = 'sticker';
                    state.contentView = '[Stiker]';
                } catch (e) {
                    console.error("Stiker yuklashda xatolik:", e);
                    bot.sendMessage(chatId, "⚠️ Stikerni yuklab olishda xatolik bo'ldi. Iltimos, boshqa stiker yoki matn yuboring.");
                    return;
                }
            } else if (text) {
                state.content = text;
                state.contentType = 'text';
                state.contentView = text;
            } else {
                 bot.sendMessage(chatId, "⚠️ Iltimos, matn yoki stiker yuboring.");
                 return;
            }
            
            state.step = 'WAITING_REYD_CONFIRM';
            bot.sendMessage(chatId, `⚔️ Reyd ma'lumotlari:\n\n🎯 Nishon: ${state.target}\n🔢 Soni: ${state.count}\n📝 Xabar: ${state.contentView}\n\nBoshlashni tasdiqlaysizmi?`, {
                reply_markup: {
                    keyboard: [["🚀 Boshlash", "🔙 Bekor qilish"]],
                    resize_keyboard: true,
                    one_time_keyboard: true
                }
            });
            return;
        }

        if (state.step === 'WAITING_REYD_CONFIRM') {
            if (text === "🚀 Boshlash") {
                bot.sendMessage(chatId, "🚀 Reyd boshlandi!", { 
                    reply_markup: { 
                        keyboard: [["⏸ Pauza", "⏹ To'xtatish"]],
                        resize_keyboard: true 
                    } 
                });
                
                // Stikerni bir marta yuklab olib, qayta-qayta ishlatish uchun bufferga o'qib olamiz (agar fayl bo'lsa)
    // let fileBuffer = null;
    // if (state.contentType === 'sticker' && fs.existsSync(state.content)) {
    //    fileBuffer = fs.readFileSync(state.content);
    // }
    
    // Asosiy o'zgarish: Fayl yo'lini (path) ham jo'natamiz, chunki uploadFile uchun kerak bo'lishi mumkin
    startReyd(chatId, userClients[chatId], state.target, state.count, state.content, state.contentType);
                delete userStates[chatId];
            } else {
                delete userStates[chatId];
                bot.sendMessage(chatId, "❌ Bekor qilindi.", { reply_markup: { remove_keyboard: true } });
            }
            return;
        }

        // --- LOGIN LOGIKASI ---
        // 1. Telefon raqam qabul qilish
        if (state.step === 'WAITING_PHONE') {
            // Raqamni tozalash va formatlash
            let phone = text.replace(/\s+/g, '').replace(/[()]/g, '');
            if (!phone.startsWith('+')) {
                phone = '+' + phone;
            }
            state.phoneNumber = phone;
            
            bot.sendMessage(chatId, `🔄 Raqam: ${state.phoneNumber}\nUlanmoqda... Kod yuborilmoqda...`);

            const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
                connectionRetries: 5,
            });
            
            state.client = client;
            loginPromises[chatId] = {};
            
            // Xavfsizlik uchun timeout (2 daqiqa)
            setTimeout(() => {
                if (userStates[chatId] && userStates[chatId].step !== 'LOGGED_IN') {
                    delete userStates[chatId];
                    delete loginPromises[chatId];
                    bot.sendMessage(chatId, "⏳ Vaqt tugadi. Iltimos, /start bosib qaytadan urinib ko'ring.");
                }
            }, 120000);

            client.start({
                phoneNumber: state.phoneNumber,
                phoneCode: async () => {
                    console.log(`[${chatId}] Kod so'ralmoqda...`);
                    state.step = 'WAITING_CODE';
                    userStates[chatId] = state;
                    bot.sendMessage(chatId, "✅ Kod yuborildi! Telegramdan kelgan **kodni** kiriting:", { parse_mode: "Markdown" });
                    return new Promise((resolve) => { loginPromises[chatId].resolveCode = resolve; });
                },
                password: async () => {
                    console.log(`[${chatId}] Parol so'ralmoqda...`);
                    state.step = 'WAITING_PASSWORD';
                    userStates[chatId] = state;
                    bot.sendMessage(chatId, "🔐 2 Bosqichli parolni yuboring:", { parse_mode: "Markdown" });
                    return new Promise((resolve) => { loginPromises[chatId].resolvePassword = resolve; });
                },
                onError: async (err) => {
                    console.error(`[${chatId}] Client error:`, err);
                    
                    // Loopni to'xtatish uchun darhol sessiyani tozalaymiz
                    if (loginPromises[chatId]) delete loginPromises[chatId];
                    if (userStates[chatId]) delete userStates[chatId];
                    
                    // Clientni to'xtatish
                    try {
                        await client.disconnect();
                        await client.destroy();
                    } catch (e) { console.error("Disconnect error:", e); }

                    if (err.message && err.message.includes('PHONE_CODE_INVALID')) {
                          bot.sendMessage(chatId, "❌ Kod noto'g'ri kiritildi. Iltimos, **/start** bosib, raqamingizni va yangi kodni qaytadan kiriting.", { parse_mode: "Markdown" });
                     } else if (err.message && err.message.includes('PHONE_NUMBER_INVALID')) {
                          bot.sendMessage(chatId, "❌ Telefon raqam noto'g'ri. /start bosib qayta urinib ko'ring.");
                     } else if (err.message && err.message.includes('wait') && err.message.includes('seconds')) {
                          const seconds = err.message.match(/\d+/)[0];
                          bot.sendMessage(chatId, `⏳ Telegram sizni vaqtincha blokladi. Iltimos, **${seconds} soniya** kuting va keyin /start bosing.`);
                     } else {
                          bot.sendMessage(chatId, `❌ Xatolik yuz berdi: ${err.message}. /start bosib qayta urinib ko'ring.`);
                     }
                 },
            }).then(async () => {
                console.log(`[${chatId}] Client connected successfully!`);
                const session = client.session.save();
                
                // Bazaga sessiyani saqlash
                await updateUser(chatId, { session: session });
                
                bot.sendMessage(chatId, "🎉 **Muvaffaqiyatli kirdingiz!** Userbot ishga tushdi.", { parse_mode: "Markdown" });
                
                state.step = 'LOGGED_IN';
                userStates[chatId] = state;
                
                // Userbotni saqlash va ishga tushirish
                userClients[chatId] = client;
                startUserbot(client, chatId);

            }).catch(async (e) => {
                 console.error(`[${chatId}] Start error:`, e);
                 
                 // Clean up
                 if (userStates[chatId]) delete userStates[chatId];
                 try {
                    await client.disconnect();
                    await client.destroy();
                 } catch (e) { console.error("Disconnect error:", e); }

                 // Agar foydalanuvchi allaqachon ulangan bo'lsa, xato berishi mumkin, lekin bu OK
                 if (e.message.includes('PHONE_NUMBER_INVALID')) {
                     bot.sendMessage(chatId, "❌ Telefon raqam noto'g'ri formatda. Qaytadan /start bosing.");
                 } else if (e.message.includes('PHONE_CODE_INVALID')) {
                     bot.sendMessage(chatId, "❌ Kod noto'g'ri. Qaytadan /start bosing.");
                 } else if (e.message.includes('wait') && e.message.includes('seconds')) {
                     const seconds = e.message.match(/\d+/)[0];
                     bot.sendMessage(chatId, `⏳ Telegram sizni vaqtincha blokladi. Iltimos, **${seconds} soniya** kuting va keyin /start bosing.`);
                 } else {
                     bot.sendMessage(chatId, `❌ Xatolik: ${e.message}. /start ni bosing.`);
                 }
            });
        }
        // 2. Kodni qabul qilish
        else if (state.step === 'WAITING_CODE') {
            const rawCode = text;
            const code = rawCode.replace(/\D/g, ''); 
            console.log(`[${chatId}] Kod qabul qilindi: ${code} (Raw: ${rawCode})`);
            
            if (loginPromises[chatId] && loginPromises[chatId].resolveCode) {
                bot.sendMessage(chatId, "🔄 Kod tekshirilmoqda...");
                loginPromises[chatId].resolveCode(code);
            } else {
                console.warn(`[${chatId}] Kod keldi, lekin promise yo'q!`);
                bot.sendMessage(chatId, "⚠️ Xatolik: Sessiya topilmadi yoki eskirgan. Iltimos, /start bosib boshidan boshlang.");
                delete userStates[chatId];
            }
        }
        // 3. Parolni qabul qilish
        else if (state.step === 'WAITING_PASSWORD') {
            const password = text.trim();
            console.log(`[${chatId}] Parol qabul qilindi.`);
            if (loginPromises[chatId] && loginPromises[chatId].resolvePassword) {
                bot.sendMessage(chatId, "🔄 Parol tekshirilmoqda...");
                loginPromises[chatId].resolvePassword(password);
            } else {
                bot.sendMessage(chatId, "⚠️ Xatolik: Sessiya topilmadi. /start bosing.");
            }
        }

    } catch (error) {
        console.error("Umumiy xatolik:", error);
        const chatId = msg.chat.id;
        bot.sendMessage(chatId, `❌ Xatolik: ${error.message}`);
    }
});




async function startAvtoUser(chatId, client, link, limit) {
    try {
        bot.sendMessage(chatId, "⏳ **Jarayon boshlandi...**\n\n1. Guruhga ulanish...");
        
        let entity = null;
        link = link.trim();

        // 1. GURUHNI ANIQLASH VA QO'SHILISH
        try {
            // A) Invite Link (t.me/+... yoki joinchat)
            if (link.includes('/+') || link.includes('joinchat')) {
                const parts = link.split(/\/(\+|joinchat)\//);
                const hash = parts.length >= 3 ? parts[2].replace(/\//g, '') : null;

                if (hash) {
                    try {
                        // ImportChatInvite - bu private guruhga qo'shilish
                        const result = await client.invoke(new Api.messages.ImportChatInvite({ hash: hash }));
                        
                        if (result.updates && result.updates.chats && result.updates.chats.length > 0) {
                            entity = result.updates.chats[0];
                        } else if (result.chats && result.chats.length > 0) {
                            entity = result.chats[0];
                        }
                    } catch (e) {
                        if (e.message && e.message.includes('USER_ALREADY_PARTICIPANT')) {
                            // Agar allaqachon a'zo bo'lsa, checkChatInvite orqali ma'lumot olishga harakat qilamiz
                            try {
                                const check = await client.invoke(new Api.messages.CheckChatInvite({ hash: hash }));
                                // check.chat bu yerda ChatInvite (title bor) yoki Channel/Chat bo'lishi mumkin
                                if (check.chat) {
                                    entity = check.chat;
                                } else {
                                    // Agar entity olinmasa, shunchaki xabar beramiz
                                    bot.sendMessage(chatId, "⚠️ Siz allaqachon guruhdasiz, lekin guruh ma'lumotlarini to'liq olib bo'lmadi. Davom etib ko'ramiz...");
                                }
                            } catch (err) {
                                console.error("CheckInvite error:", err);
                            }
                        } else {
                            throw e;
                        }
                    }
                }
            } 
            // B) Public Link yoki Username (@guruh)
            else {
                let username = link;
                if (link.includes('t.me/')) {
                    const parts = link.split('t.me/');
                    if (parts.length > 1) {
                        username = parts[1].split('/')[0].split('?')[0];
                    }
                }
                username = username.replace('@', '');

                try {
                    entity = await client.getEntity(username);
                    // Qo'shilishga harakat qilamiz
                    await client.invoke(new Api.channels.JoinChannel({ channel: entity }));
                } catch (e) {
                    if (e.message && !e.message.includes('USER_ALREADY_PARTICIPANT')) {
                         console.error("Join public error:", e);
                         throw e;
                    }
                }
            }
        } catch (e) {
            console.error("Join error:", e);
            bot.sendMessage(chatId, `❌ **Xatolik:** Guruhga kirib bo'lmadi.\nLink noto'g'ri yoki bot spamga tushgan bo'lishi mumkin.\n\nDetal: ${e.message}`);
            return;
        }

        if (!entity) {
            // Agar entity null bo'lsa (masalan already participant bo'lib, entity resolve bo'lmasa)
            // Biz getDialogs orqali qidirib ko'rishimiz mumkin, lekin bu og'ir operatsiya.
            bot.sendMessage(chatId, "❌ Guruh ma'lumotlarini aniqlab bo'lmadi. Iltimos, linkni tekshiring.");
            return;
        }

        const title = entity.title || "Guruh";
        const safeTitle = title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        bot.sendMessage(chatId, `✅ <b>${safeTitle}</b> guruhiga ulanildi.\n\n2. A'zolar ro'yxati shakllantirilmoqda...`, { parse_mode: "HTML" });

        // 2. MA'LUMOTLARNI YIG'ISH
        let admins = [];
        let members = [];
        
        try {
            // 2.1 Adminlarni olish
            try {
                // ChannelParticipantsAdmins faqat Channel/Supergroup uchun ishlaydi
                const adminsIter = client.iterParticipants(entity, { filter: new Api.ChannelParticipantsAdmins() });
                for await (const user of adminsIter) {
                    if (user.deleted || user.bot || user.isSelf) continue;
                    if (user.username) {
                         admins.push(`@${user.username}`);
                    }
                }
            } catch (e) {
                console.log("Admin fetch error (skipping):", e.message);
            }

            // 2.2 Memberlarni olish - BATCH HISTORY SCRAPING (ID orqali yig'ish va keyin aniqlash)
            // Bu usul eng tez va samarali, chunki har bir xabar uchun alohida so'rov yubormaydi.
            const uniqueUsernames = new Set();
            
            // Adminlarni dublikat qilmaslik uchun setga qo'shamiz
            admins.forEach(admin => {
                const raw = admin.replace(/^@/, '');
                uniqueUsernames.add(raw);
            });

            // 1. Recent Users (Tezkor)
            try {
                const recentResult = await client.invoke(new Api.channels.GetParticipants({
                    channel: entity,
                    filter: new Api.ChannelParticipantsRecent(),
                    offset: 0,
                    limit: limit,
                    hash: 0
                }));
                
                if (recentResult && recentResult.users) {
                    recentResult.users.forEach(user => {
                        if (members.length >= limit) return;
                        if (user.deleted || user.bot || user.isSelf) return;
                        if (!user.username) return;

                        if (!uniqueUsernames.has(user.username)) {
                            uniqueUsernames.add(user.username);
                            members.push(`@${user.username}`);
                        }
                    });
                }
            } catch (e) {
                // console.log("Recent failed:", e.message);
            }

            // 2. History Scan (Chuqur qidiruv)
            // Agar Recent yetarli bo'lmasa, Tarixni skaner qilamiz
            if (members.length < limit) {
                try {
                    // 3000 ta xabar tarixini skaner qilamiz
                    const historyLimit = 3000;
                    
                    for await (const message of client.iterMessages(entity, { limit: historyLimit })) {
                        if (members.length >= limit) break;
                        
                        // message.sender odatda iterMessages da keladi (agar cache da bo'lsa)
                        let user = message.sender;

                        // Agar sender bo'lmasa, ID orqali olishga harakat qilamiz (kamdan-kam holat)
                        if (!user && message.fromId && message.fromId.userId) {
                            try {
                                const result = await client.invoke(new Api.users.GetUsers({
                                    id: [message.fromId]
                                }));
                                if (result && result.length > 0) user = result[0];
                            } catch (err) {
                                // Ignore fetch error
                            }
                        }

                        if (user && user.className === 'User') {
                            if (user.deleted || user.bot || user.isSelf) continue;
                            if (!user.username) continue;

                            if (!uniqueUsernames.has(user.username)) {
                                uniqueUsernames.add(user.username);
                                members.push(`@${user.username}`);
                            }
                        }
                    }
                } catch (e) {
                    console.log("History scan failed:", e.message);
                }
            }
        } catch (e) {
            console.error("Member fetch error:", e);
            bot.sendMessage(chatId, `❌ A'zolarni olishda xatolik: ${e.message}`);
            return;
        }

        if (members.length === 0 && admins.length === 0) {
            bot.sendMessage(chatId, "❌ Hech qanday foydalanuvchi topilmadi (username borlar). Guruh a'zolari yashirilgan bo'lishi mumkin.");
            return;
        }

        // 3. NATIJANI YUBORISH (TEXT)
        const total = admins.length + members.length;
        
        let resultMessage = `📊 NATIJA:\n\n`;
        resultMessage += `👑 Adminlar: ${admins.length} ta\n`;
        resultMessage += `👥 Azolar: ${members.length} ta\n`;
        resultMessage += `📦 Jami: ${total} ta\n\n`;

        if (admins.length > 0) {
            resultMessage += `👑 <b>ADMINLAR USERNAMELARI:</b>\n${admins.join('\n')}\n\n`;
        }

        if (members.length > 0) {
            resultMessage += `👥 <b>AZOLAR USERNAMELARI:</b>\n${members.join('\n')}`;
        }

        const mainMenu = {
            reply_markup: {
                keyboard: [
                    ["💎 Avto Almaz", "👤 AvtoUser"],
                    ["⚔️ Avto Reyd", "📣 Avto Reklama"],
                    ["📊 Profil", "🔄 Nomer almashtirish"],
                    ["🧾 Yordam"]
                ],
                resize_keyboard: true
            }
        };

        // Xabarni bo'laklab yuborish (Telegram limit 4096)
        if (resultMessage.length > 4000) {
            const parts = resultMessage.match(/[\s\S]{1,4000}/g) || [];
            for (let i = 0; i < parts.length; i++) {
                const part = parts[i];
                if (i === parts.length - 1) {
                    await bot.sendMessage(chatId, part, { parse_mode: "HTML", ...mainMenu });
                } else {
                    await bot.sendMessage(chatId, part, { parse_mode: "HTML" });
                }
            }
        } else {
            await bot.sendMessage(chatId, resultMessage, { parse_mode: "HTML", ...mainMenu });
        }

    } catch (err) {
        console.error("General AvtoUser error:", err);
        bot.sendMessage(chatId, `❌ Kutilmagan xatolik: ${err.message}`);
    }
}

async function startReyd(chatId, client, target, count, content, contentType) {
    try {
        reydSessions[chatId] = { status: 'active', count: 0, target: target };
        let sent = 0;
        let errors = 0;

        // Targetni aniqlash va guruhga qo'shilish
        let finalTarget = target;
        try {
            // Agar target link bo'lsa (https://t.me/...)
            if (target.includes("t.me/")) {
                const inviteLink = target.split("t.me/")[1].replace("+", "").trim();
                
                // Agar public link bo'lsa (username)
                if (!target.includes("+") && !inviteLink.includes("joinchat")) {
                     finalTarget = "@" + inviteLink.replace("joinchat/", "").replace("/", "");
                } 
                // Agar private link bo'lsa (joinchat yoki +)
                else {
                    try {
                        bot.sendMessage(chatId, "🔄 Guruhga qo'shilishga urinilmoqda...");
                        const result = await client.invoke(new Api.messages.ImportChatInvite({
                            hash: inviteLink.replace("joinchat/", "").replace("+", "")
                        }));
                        
                        // Muvaffaqiyatli qo'shildi, endi chat ID yoki entityni olamiz
                        if (result.updates && result.updates.length > 0) {
                            // Chat ID ni topishga harakat qilamiz
                            // Odatda result.chats[0] da bo'ladi
                            if (result.chats && result.chats.length > 0) {
                                finalTarget = result.chats[0]; // Entityni o'zini ishlatamiz
                            }
                        } else if (result.chat) {
                            finalTarget = result.chat;
                        }
                    } catch (joinErr) {
                        // Agar allaqachon a'zo bo'lsa (USER_ALREADY_PARTICIPANT)
                        if (joinErr.message.includes('USER_ALREADY_PARTICIPANT')) {
                             // A'zo bo'lsa, demak entityni checkChatInvite orqali yoki getEntity orqali olish mumkin
                             // Yoki shunchaki linkni o'zini ishlatib ko'ramiz (ba'zida ishlaydi), lekin entityga o'girgan ma'qul.
                             // Eng yaxshisi: CheckChatInvite orqali chatni olish
                             try {
                                const inviteCheck = await client.invoke(new Api.messages.CheckChatInvite({
                                    hash: inviteLink.replace("joinchat/", "").replace("+", "")
                                }));
                                if (inviteCheck.chat) {
                                    finalTarget = inviteCheck.chat;
                                }
                             } catch (checkErr) {
                                 console.error("Check invite error:", checkErr);
                             }
                        } else {
                            throw joinErr; // Boshqa xato bo'lsa
                        }
                    }
                }
            }
        } catch (e) {
            console.error("Target resolve error:", e);
            bot.sendMessage(chatId, `⚠️ Guruhni aniqlab bo'lmadi yoki qo'shilib bo'lmadi: ${e.message}`);
            // Davom etishga harakat qilamiz (balki target to'g'ridir)
        }

        bot.sendMessage(chatId, `🚀 Reyd boshlanmoqda: ${target} ga ${count} ta xabar.`);

        for (let i = 0; i < count; i++) {
            // Check status
            while (reydSessions[chatId] && reydSessions[chatId].status === 'paused') {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }

            if (!reydSessions[chatId] || reydSessions[chatId].status === 'stopped') {
                break;
            }

            try {
                // Send message using userbot
                if (contentType === 'sticker') {
                    // Stikerni fayl yo'li orqali yuborish
                    // forceDocument: false - stiker sifatida yuborishga harakat qiladi
                    // Attributes qo'shish orqali aniq stiker ekanligini bildiramiz
                    await client.sendMessage(finalTarget, { 
                        file: content, 
                        forceDocument: false,
                        attributes: [
                            new Api.DocumentAttributeSticker({
                                alt: '👋',
                                stickerset: new Api.InputStickerSetEmpty()
                            })
                        ]
                    });
                } else {
                    await client.sendMessage(finalTarget, { message: content });
                }
                sent++;
            } catch (e) {
                console.error(`Reyd error (${i}):`, e);
                errors++;
                // If critical error (like peer flood), maybe stop?
                if (e.message && (e.message.includes('FLOOD_WAIT') || e.message.includes('PEER_FLOOD'))) {
                    bot.sendMessage(chatId, `⚠️ Telegram cheklovi (Flood Wait). Reyd to'xtatildi.`);
                    break;
                }
            }
            
            // Wait a bit to avoid instant ban (tezlik oshirildi: 50ms)
            await new Promise(resolve => setTimeout(resolve, 50));
        }

        delete reydSessions[chatId];
        
        // Agar stiker bo'lsa, vaqtinchalik faylni o'chirish
        if (contentType === 'sticker') {
            try {
                if (fs.existsSync(content)) {
                    fs.unlinkSync(content);
                }
            } catch (e) {
                console.error("Temp file delete error:", e);
            }
        }

        const mainMenu = {
            reply_markup: {
                keyboard: [
                    ["💎 Avto Almaz", "👤 AvtoUser"],
                    ["⚔️ Avto Reyd", "📣 Avto Reklama"],
                    ["📊 Profil", "🔄 Nomer almashtirish"],
                    ["🧾 Yordam"]
                ],
                resize_keyboard: true
            }
        };

        bot.sendMessage(chatId, `🏁 **Reyd yakunlandi!**\n\n✅ Yuborildi: ${sent}\n❌ Xatolik: ${errors}`, { 
            parse_mode: "Markdown",
            ...mainMenu
        });

    } catch (e) {
        console.error("Reyd fatal error:", e);
        if (reydSessions[chatId]) delete reydSessions[chatId];
        bot.sendMessage(chatId, `❌ Reyd xatolik bilan tugadi: ${e.message}`);
    }
}

async function startReklama(chatId, client, users, text) {
    let sentCount = 0;
    let failCount = 0;
    
    for (let i = 0; i < users.length; i++) {
        const username = users[i];
        try {
            await client.sendMessage(username, { message: text });
            sentCount++;
            console.log(`[${chatId}] Reklama yuborildi: ${username}`);
        } catch (err) {
            failCount++;
            console.error(`[${chatId}] Reklama xatolik (${username}):`, err);
            
            if (err.message && (err.message.includes('PEER_FLOOD') || err.message.includes('FLOOD_WAIT') || err.message.includes('spam'))) {
                bot.sendMessage(chatId, `⚠️ **DIQQAT!** Telegram sizni vaqtincha spam qildi.\nReklama to'xtatildi.\nYuborildi: ${sentCount}\nO'xshamadi: ${failCount}`);
                return; 
            }
        }
        
        // 1 sekund kutish
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    const mainMenu = {
        reply_markup: {
            keyboard: [
                ["💎 Avto Almaz", "👤 AvtoUser"],
                ["⚔️ Avto Reyd", "📣 Avto Reklama"],
                ["📊 Profil", "🔄 Nomer almashtirish"],
                ["🧾 Yordam"]
            ],
            resize_keyboard: true
        }
    };
    
    bot.sendMessage(chatId, `✅ **Reklama yakunlandi!**\n\nJami: ${users.length}\nYuborildi: ${sentCount}\nO'xshamadi: ${failCount}`, { parse_mode: "Markdown", ...mainMenu });
}

async function startUserbot(client, chatId) {
    console.log(`Userbot ${chatId} uchun ishga tushdi.`);
    
    client.addEventHandler(async (event) => {
        const message = event.message;
        
        // Faqat tugmasi bor xabarlarni tekshiramiz
        if (message && message.buttons && message.buttons.length > 0) {
            // Tugmalar orasidan 💎 borini qidiramiz
            let clicked = false;
            
            // GramJS da buttons 2D array (qatorlar va ustunlar)
            // Biz barcha tugmalarni tekshiramiz
            const rows = message.buttons;
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                for (let j = 0; j < row.length; j++) {
                    const button = row[j];
                    if (button.text && button.text.includes('💎')) {
                        // FIX: O'zining menyu tugmalarini bosmasligi kerak
                        const btnText = button.text;
                        if (btnText.includes('Avto Almaz') || 
                            btnText.includes('AvtoUser') ||
                            btnText.includes('Avto Reyd') ||
                            btnText.includes('Avto Reklama') ||
                            btnText.includes('Profil') ||
                            btnText.includes('Nomer almashtirish') ||
                            btnText.includes('Yordam')) {
                            continue;
                        }

                        console.log(`[${chatId}] 💎 tugma topildi: ${button.text}`);
                        try {
                            // message.click(i, j) - qator va ustun bo'yicha bosish
                            // Yoki shunchaki message.click(button) ishlashi mumkin, lekin gramjs da index ishonchliroq
                            // message.click() argumenti index (flat) yoki (row, col) bo'lishi mumkin. 
                            // GramJS docs ga ko'ra: message.click(i, j)
                            
                            // Ammo oddiy click(0) flat index ishlatadi.
                            // Keling, i va j ni ishlatamiz.
                            await message.click(i, j);
                            console.log(`[${chatId}] ✅ Tugma bosildi!`);
                            clicked = true;
                            
                            // Statistikani yangilash
                            await updateStats(chatId);
                            const user = await getUser(chatId);
                            const totalClicks = user ? user.clicks : 1;

                            // Guruh nomini olish
                            let chatTitle = "Noma'lum guruh";
                            try {
                                const chat = await message.getChat();
                                chatTitle = chat.title || chat.firstName || "Guruh";
                            } catch (e) {
                                console.error("Chat title error:", e);
                            }
                            
                            bot.sendMessage(chatId, `💎 **${totalClicks}-almaz**\n📂 Guruh: **${chatTitle}**`, { parse_mode: "Markdown" });
                            
                            // Bir marta bosilgandan keyin to'xtash (bitta xabarda bir nechta almaz bo'lsa ham)
                            break;
                        } catch (err) {
                            console.error("Tugmani bosishda xatolik:", err);
                        }
                    }
                }
                if (clicked) break;
            }
            // 2. Agar tugmalarda topilmasa, matnni tekshiramiz
            if (!clicked && message.text && message.text.includes('💎')) {
                 const text = message.text.toLowerCase();
                 
                 // Filterlash: "User joined" kabi xabarlarni o'tkazib yuborish
                 const ignoreWords = ['joined', "qo'shildi", 'kirdi', 'left', 'chiqdi', 'kick', 'ban', 'promoted', 'admin', 'asosiy menyu', 'bu bot orqali siz'];
                 const shouldIgnore = ignoreWords.some(word => text.includes(word));
                 
                 // Tasdiqlash: O'yin yoki bonus ekanligini bildiruvchi so'zlar
                 const validWords = ['olish', 'bonus', 'sovg\'a', 'yut', 'bos', 'click', 'press', 'yig'];
                 const hasValidWord = validWords.some(word => text.includes(word));
                 
                 // Yoki raqam bilan kelgan bo'lsa (Masalan: "10 💎")
                 const hasNumber = /\d/.test(text);

                 if (!shouldIgnore && (hasValidWord || hasNumber)) {
                     console.log(`[${chatId}] Matnda 💎 topildi va validatsiya o'tdi, 1-tugma bosilmoqda...`);
                     try {
                         await message.click(0); // Birinchi tugmani bosish
                         console.log(`[${chatId}] ✅ Tugma bosildi (Text match)!`);
                         
                         // Statistikani yangilash
                         await updateStats(chatId);
                         const user = await getUser(chatId);
                         const totalClicks = user ? user.clicks : 1;
    
                         let chatTitle = "Noma'lum guruh";
                         try {
                             const chat = await message.getChat();
                             chatTitle = chat.title || chat.firstName || "Guruh";
                         } catch (e) { console.error("Chat title error:", e); }
                         
                         bot.sendMessage(chatId, `💎 **${totalClicks}-almaz**\n📂 Guruh: **${chatTitle}**`, { parse_mode: "Markdown" });
    
                     } catch (err) {
                         console.error("Text match click error:", err);
                     }
                 } else {
                     console.log(`[${chatId}] 💎 bor, lekin bu 'User Joined' yoki boshqa xabar deb topildi.`);
                 }
            }
        }
    }, new NewMessage({}));
}

// Bot qayta ishga tushganda sessiyalarni tiklash
async function restoreUserSession(chatId, sessionString) {
    try {
        console.log(`Sessiyani tiklash: ${chatId}`);
        const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
            connectionRetries: 5,
        });
        await client.connect();
        userClients[chatId] = client;
        startUserbot(client, chatId);
        console.log(`Userbot ${chatId} qayta tiklandi.`);
    } catch (e) {
        console.error(`Sessiyani tiklashda xatolik (${chatId}):`, e);
        bot.sendMessage(chatId, "⚠️ Sessiyangiz eskirgan bo'lishi mumkin. Iltimos, /start bosib qaytadan kiring.");
        await updateUser(chatId, { session: null }); // Sessiyani o'chirish
    }
}

// Bot ishga tushganda barcha saqlangan sessiyalarni yuklash
(async () => {
    const users = await getUsers();
    for (const user of users) {
        if (user.status === 'approved' && user.session) {
            await restoreUserSession(user.chatId, user.session);
        }
    }
})();

// Xatolarni ushlash
bot.on('polling_error', (error) => {
    console.error(`Polling xatosi: ${error.code} - ${error.message}`);
});
