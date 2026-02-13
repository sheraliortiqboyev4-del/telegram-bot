require('dotenv').config();
const dns = require('dns');
// Google DNS serverlarini o'rnatish (SRV record xatoliklarini oldini olish uchun)
try {
    dns.setServers(['8.8.8.8', '8.8.4.4']);
} catch (e) {
    console.log("DNS serverlarini o'zgartirib bo'lmadi, standart sozlamalar ishlatiladi.");
}

const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
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

    console.log('Bot ishga tushdi (v2)...');
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
                         ["💎 Avto Almaz", "� AvtoUser"],
                         ["� Admin ID", "📣 Avto Reklama"],
                         ["📊 Profil", "🔄 Nomer almashtirish"],
                         ["🧾 Yordam"]
                     ],
                     resize_keyboard: true
                 }
             };

             bot.sendMessage(chatId, `👋 Assalomu alaykum, Hurmatli **${user.name}**!\n\n🤖 **Bu bot orqali siz:**\n• 💎 **Avto Almaz** - avtomatik almaz yig'ish\n• 👥 **AvtoYuser** - guruhdan foydalanuvchilarni yig'ish (Tez kunda)\n• � **Avto Reklama** - foydalanuvchilarga reklama yuborish\n\nBotdan foydalanish uchun menudan tanlang!`, {
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
                    ["👮 Admin ID", "📣 Avto Reklama"],
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
    const chatId = msg.chat.id;
    const text = msg.text;

    if (!text) return;

    // --- MENYU TUGMALARI LOGIKASI ---
    if (text === "💎 Avto Almaz") {
        const user = await getUser(chatId);
        if (user && user.session) {
             const clicks = user.clicks || 0;
             bot.sendMessage(chatId, `💎 **Avto Almaz**\n\n✅ **Holat:** Faol\n💎 **Jami to'plangan:** ${clicks} ta\n\nBot avtomatik ravishda guruhlardagi 💎 tugmalarini bosib almaz yig'moqda.`, { parse_mode: "Markdown" });
        } else {
             bot.sendMessage(chatId, "❌ Bu bo'limga kirish uchun avval tizimga kiring (/start).");
        }
        return;
    }

    if (text === "👤 AvtoUser") {
        const user = await getUser(chatId);
        if (!user || user.status !== 'approved' || !userClients[chatId]) {
            bot.sendMessage(chatId, "❌ Bu funksiyadan foydalanish uchun avval ro'yxatdan o'ting va hisobingizga kiring.");
            return;
        }
        userStates[chatId] = { step: 'WAITING_AVTOUSER_LINK' };
        bot.sendMessage(chatId, "👤 **AvtoUser**\n\nIltimos, foydalanuvchilar yig'iladigan guruh linkini yuboring:\n(Masalan: https://t.me/guruh_linki yoki @guruh)", { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } });
        return;
    }

    if (text === "👮 Admin ID") {
        const user = await getUser(chatId);
        if (!user || user.status !== 'approved' || !userClients[chatId]) {
            bot.sendMessage(chatId, "❌ Bu funksiyadan foydalanish uchun avval ro'yxatdan o'ting va hisobingizga kiring.");
            return;
        }
        userStates[chatId] = { step: 'WAITING_ADMINID_LINK' };
        bot.sendMessage(chatId, "👮 **Admin ID**\n\nIltimos, adminlar aniqlanadigan guruh linkini yuboring:", { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } });
        return;
    }

    if (text === "📣 Avto Reklama") {
        // /rek funksiyasini chaqiramiz (msg obyektini simulyatsiya qilamiz yoki shunchaki logikani takrorlaymiz)
        // Lekin eng osoni - mavjud /rek listenerini ishlatish emas, balki logikani shu yerda chaqirish.
        // Yoki shunchaki userStates ga yozib yuborish.
        
        const user = await getUser(chatId);
        if (!user || user.status !== 'approved' || !userClients[chatId]) {
            bot.sendMessage(chatId, "❌ Bu funksiyadan foydalanish uchun avval ro'yxatdan o'ting va hisobingizga kiring.");
            return;
        }
    
        userStates[chatId] = { step: 'WAITING_REK_USERS' };
        bot.sendMessage(chatId, "🚀 **Avto Reklama**\n\nIltimos, reklama yuboriladigan foydalanuvchilar username-larini yuboring.\n\n_Misol:_\n@user1\n@user2\n@user3\n\n(Maksimum 100 ta username)", { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } }); // Keyboardni vaqtincha olib tashlaymiz
        return;
    }

    if (text === "📊 Profil") {
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

    if (text === "🔄 Nomer almashtirish") {
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

    if (text === "🧾 Yordam") {
        const helpText = "🧾 **Yordam**\n📌 **Funksiyalar:**\n\n💎 **Avto Almaz**\nGuruhlarda almazli tugmalarni avtomatik bosadi. Avto Almaz Knopkasida Bir marta bosish orqali almazlarni yig'ishni boshlaydi. Agar yana bir marta bosilsa almazlarni yig'ishni to'xtatadi.\n\n👤 **AvtoUser**\nGuruhdan foydalanuvchilarni yuserlarini yig'adi va sizga yuboradi maksimal 1000 ta (yuser yig'ish jarayoni voqt olishi mumkin iltimos sabirli bo'ling). 🔗 Guruh linki va limitni kiriting.\n\n📢 **Avto Reklama**\nSiz botga yuborgan 100 ta yuserga reklama yuboradi.(unutmang 200 ta yuser yuborsangiz ham faqat ularni 100 tasini oladi ) Userlar va reklama matnini kiriting.\n\n📊 **Profil**\nSizning statistikangizni ko'rsatadi.\n\n🔄 **Nomer almashtirish**\nTelefon raqamingizni o'zgartirish.";
        bot.sendMessage(chatId, helpText, { parse_mode: "Markdown" });
        return;
    }

    if (text.startsWith('/')) return;

    let state = userStates[chatId];
    if (!state) return;

    // Faqat tasdiqlangan userlar login qila oladi
    const user = await getUser(chatId);
    if (!user || user.status !== 'approved') return;

    try {
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

        // --- AVTOUSER LOGIKASI ---
        if (state.step === 'WAITING_AVTOUSER_LINK') {
            state.targetLink = text;
            state.step = 'WAITING_AVTOUSER_LIMIT';
            bot.sendMessage(chatId, "🔢 Nechta foydalanuvchi kerak? (Maksimal 1000)", { parse_mode: "Markdown" });
            return;
        }

        if (state.step === 'WAITING_AVTOUSER_LIMIT') {
            let limit = parseInt(text);
            if (isNaN(limit) || limit <= 0) limit = 100; 
            if (limit > 1000) limit = 1000;

            bot.sendMessage(chatId, `✅ Tushunarli. **${state.targetLink}** guruhidan **${limit}** ta user yig'ilmoqda...`, { parse_mode: "Markdown" });
            
            // Start process
            scrapeUsers(chatId, userClients[chatId], state.targetLink, limit);
            
            delete userStates[chatId]; 
            return;
        }

        // --- ADMIN ID LOGIKASI ---
        if (state.step === 'WAITING_ADMINID_LINK') {
            bot.sendMessage(chatId, `✅ Tushunarli. **${text}** guruhidan adminlar aniqlanmoqda...`, { parse_mode: "Markdown" });
            
            scrapeAdmins(chatId, userClients[chatId], text);
            
            delete userStates[chatId];
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
        bot.sendMessage(chatId, `❌ Xatolik: ${error.message}`);
    }
});

// Userbot logikasi
// --- YORDAMCHI FUNKSIYALAR ---
async function scrapeUsers(chatId, client, link, limit) {
    try {
        let entity;
        
        // Linkni tozalash
        link = link.trim();
        
        // 1. Entity ni aniqlash va guruhga qo'shilish
        try {
            if (link.includes('/+') || link.includes('joinchat')) {
                // Yopiq guruh (Invite link)
                const hash = link.split(/\/(\+|joinchat)\//)[1];
                if (hash) {
                    try {
                        const result = await client.invoke(new Api.messages.ImportChatInvite({ hash: hash }));
                        if (result.updates && result.updates.chats && result.updates.chats.length > 0) {
                             entity = result.updates.chats[0];
                        } else if (result.chats && result.chats.length > 0) {
                             entity = result.chats[0];
                        }
                    } catch (e) {
                        if (e.message.includes('USER_ALREADY_PARTICIPANT')) {
                            // Agar allaqachon a'zo bo'lsa, oddiy getEntity bilan olib ko'ramiz
                            // (Invite linkdan hashni olib CheckChatInvite qilish mumkin, lekin getEntity qiyin)
                            // Shuning uchun userdan username so'rash yaxshiroq, lekin harakat qilamiz
                        } else {
                            throw e;
                        }
                    }
                }
            }
            
            if (!entity) {
                entity = await client.getEntity(link);
            }

            // Guruhga qo'shilishga harakat qilish (agar public bo'lsa)
            try {
                await client.invoke(new Api.channels.JoinChannel({ channel: entity }));
            } catch (e) {
                // Agar allaqachon a'zo bo'lsa yoki xatolik bo'lsa (jim yutamiz)
            }

        } catch (e) {
            console.error("Entity resolve error:", e);
            bot.sendMessage(chatId, "❌ Guruh topilmadi yoki unga kirish imkoni yo'q. Iltimos, link to'g'riligini tekshiring yoki bot (akkaunt) guruhga a'zo ekanligiga ishonch hosil qiling.");
            return;
        }
        
        // 2. Get Admins
        let adminsList = [];
        const adminIds = new Set();
        
        try {
            const adminsArr = await client.getParticipants(entity, { filter: new Api.ChannelParticipantsAdmins() });
            
            for (const admin of adminsArr) {
                 const username = admin.username ? `@${admin.username}` : `ID: ${admin.id}`;
                 adminsList.push(username);
                 adminIds.add(admin.id.toString());
            }
        } catch (e) {
            console.error("Admin scrape warning:", e);
            // Adminlarni ololmasak ham davom etamiz
        }

        // 3. Get Members (Iterate)
        let membersList = [];
        let count = 0;
        
        // Status xabarini yangilash
        const statusMsg = await bot.sendMessage(chatId, "🔄 Foydalanuvchilar yig'ilmoqda... Iltimos kuting.");
        
        try {
            for await (const user of client.iterParticipants(entity, { limit: limit + adminsList.length + 50 })) { 
                 if (count >= limit) break;
                 if (user.bot || user.deleted) continue;

                 const username = user.username ? `@${user.username}` : `ID: ${user.id}`;
                 
                 // Check if this user is an admin
                 if (adminIds.has(user.id.toString())) {
                     // Already in adminsList
                 } else {
                     membersList.push(username);
                     count++;
                 }
            }
        } catch (e) {
             console.error("Iterate error:", e);
             // Borini yozamiz
        }

        if (membersList.length === 0 && adminsList.length === 0) {
            bot.sendMessage(chatId, "❌ Foydalanuvchilarni olib bo'lmadi. Guruh sozlamalarini tekshiring (userlarni ko'rish yopiq bo'lishi mumkin).");
            return;
        }

        const fileContent = `ADMINLAR (${adminsList.length}):\n${adminsList.join('\n')}\n\nAZOLAR (${membersList.length}):\n${membersList.join('\n')}`;
        const filePath = `./users_${chatId}.txt`; // Renderda rootga yozish mumkin, vaqtinchalik
        fs.writeFileSync(filePath, fileContent);
        
        await bot.sendDocument(chatId, filePath, { 
            caption: `✅ **Jarayon yakunlandi!**\n\n👮 Adminlar: ${adminsList.length}\n👤 A'zolar: ${membersList.length}\n📂 Jami: ${adminsList.length + membersList.length}` 
        });
        
        // Faylni o'chirish
        try {
            fs.unlinkSync(filePath);
        } catch (e) {}
        
        // Status xabarni o'chirish
        bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});

    } catch (e) {
        console.error("Scrape error:", e);
        bot.sendMessage(chatId, `❌ Xatolik yuz berdi: ${e.message}`);
    }
}

async function scrapeAdmins(chatId, client, link) {
    try {
        link = link.trim();
        let entity;
        
        try {
             entity = await client.getEntity(link);
             // Join qilishga harakat
             try { await client.invoke(new Api.channels.JoinChannel({ channel: entity })); } catch (e) {}
        } catch (e) {
             bot.sendMessage(chatId, "❌ Guruh topilmadi. Linkni tekshiring.");
             return;
        }

        const adminsArr = await client.getParticipants(entity, { filter: new Api.ChannelParticipantsAdmins() });
        
        if (!adminsArr || adminsArr.length === 0) {
            bot.sendMessage(chatId, "⚠️ Adminlar topilmadi yoki ro'yxatni olish imkoni yo'q.");
            return;
        }

        let message = `👮 **Guruh Adminlari (${adminsArr.length}):**\n\n`;
        for (const admin of adminsArr) {
            const username = admin.username ? `@${admin.username}` : "Username yo'q";
            const name = (admin.firstName || '') + ' ' + (admin.lastName || '');
            message += `👤 ${name.trim() || 'Admin'}\n   ├ Username: ${username}\n   └ ID: \`${admin.id}\`\n\n`;
        }
        
        if (message.length > 4000) {
            const chunks = message.match(/.{1,4000}/g);
            for (const chunk of chunks) {
                await bot.sendMessage(chatId, chunk, { parse_mode: "Markdown" });
            }
        } else {
            await bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
        }
        
    } catch (e) {
        console.error("Admin scrape error:", e);
        bot.sendMessage(chatId, `❌ Xatolik: ${e.message}`);
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
    
    bot.sendMessage(chatId, `✅ **Reklama yakunlandi!**\n\nJami: ${users.length}\nYuborildi: ${sentCount}\nO'xshamadi: ${failCount}`, { parse_mode: "Markdown" });
}

async function startUserbot(client, chatId) {
    console.log(`Userbot ${chatId} uchun ishga tushdi.`);
    
    client.addEventHandler(async (event) => {
        const message = event.message;
        // 1. Matnda 💎 bo'lishi kerak
        // 2. Xabarda tugmalar bo'lishi shart
        if (message && message.text && message.text.includes('💎')) {
            if (message.buttons && message.buttons.length > 0) {
                console.log(`[${chatId}] 💎 va tugma topildi!`);
                try {
                    await message.click(0);
                    console.log(`[${chatId}] ✅ Tugma bosildi!`);
                    
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
                } catch (err) {
                    console.error("Tugmani bosishda xatolik:", err);
                }
            } else {
                // Tugmasiz xabarlarni shunchaki ignor qilamiz (log yozmaymiz)
                // console.log(`[${chatId}] 💎 bor, lekin tugma yo'q.`);
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
