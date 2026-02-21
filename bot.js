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
    joinedAt: { type: Date, default: Date.now },
    reydCount: { type: Number, default: 0 },
    usersGathered: { type: Number, default: 0 },
    adsCount: { type: Number, default: 0 }
});

const User = mongoose.model('User', userSchema);

// Botni yaratish
const bot = new TelegramBot(token, { polling: true });

// Error Handling
bot.on('polling_error', (error) => {
    console.error(`[Polling Error] ${error.code}: ${error.message}`);
});

process.on('uncaughtException', (error) => {
    console.error('[Uncaught Exception]', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[Unhandled Rejection]', reason);
});

// Helper: Safe Send Message (Markdown fail bo'lsa, oddiy text yuborish)
const sendSafeMessage = async (chatId, text, options = {}) => {
    try {
        await bot.sendMessage(chatId, text, options);
    } catch (e) {
        console.error(`Failed to send Markdown message to ${chatId}:`, e.message);
        if (options.parse_mode) {
            delete options.parse_mode;
            // Markdown belgilarni olib tashlash (oddiy matn uchun)
            const plainText = text.replace(/\*\*/g, '').replace(/__/g, '').replace(/`/g, '');
            try {
                await bot.sendMessage(chatId, plainText, options);
            } catch (e2) {
                console.error(`Failed to send plain text message to ${chatId}:`, e2.message);
            }
        }
    }
};

// Helper: Escape Markdown
const escapeMarkdown = (text) => {
    if (!text) return '';
    return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
};

// Foydalanuvchi holatlari
const userStates = {};
const avtoAlmazStates = {}; // Avto Almaz statusi
const reydSessions = {}; // Reyd sessiyalari
const reklamaSessions = {}; // Reklama sessiyalari
// Promise-larni saqlash uchun
const loginPromises = {};
// Userbot clients
const userClients = {};

// Helper: Asosiy menyu (Inline)
function getMainMenu(chatId) {
    const isAdmin = chatId && ADMIN_ID && chatId.toString() === ADMIN_ID.toString();
    const lastRow = isAdmin 
        ? [{ text: "👨‍💻 Admin Panel", callback_data: "admin_panel" }]
        : [{ text: "🧾 Yordam", callback_data: "menu_help" }];

    return {
        reply_markup: {
            inline_keyboard: [
                [{ text: "💎 Avto Almaz", callback_data: "menu_almaz" }, { text: "👤 AvtoUser", callback_data: "menu_avtouser" }],
                [{ text: "⚔️ Avto Reyd", callback_data: "menu_reyd" }, { text: "📣 Avto Reklama", callback_data: "menu_reklama" }],
                [{ text: "📊 Profil", callback_data: "menu_profile" }, { text: "🔄 Nomer almashtirish", callback_data: "menu_logout" }],
                lastRow
            ]
        }
    };
}

// Helper: Admin Menyu
function getAdminMenu() {
    return {
        reply_markup: {
            inline_keyboard: [
                [{ text: "📊 Statistika", callback_data: "admin_stats" }, { text: "👥 Barcha A'zolar", callback_data: "admin_all_users" }],
                [{ text: "⏳ Kutilayotganlar", callback_data: "admin_pending" }, { text: "✅ Tasdiqlanganlar", callback_data: "admin_approved" }],
                [{ text: "🚫 Bloklanganlar", callback_data: "admin_blocked" }],
                [{ text: "🔙 Orqaga", callback_data: "menu_back_main" }]
            ],
            resize_keyboard: true
        }
    };
}

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
    try {
        const chatId = msg.chat.id;
        const name = msg.from.first_name || "Foydalanuvchi";
        const safeName = name.replace(/[*_`\[\]()]/g, '') || "Foydalanuvchi";
        
        console.log(`User started: ${name} (${chatId})`);



        let user = await getUser(chatId);
        
        // Agar foydalanuvchi Admin bo'lsa, uni avtomatik 'approved' qilamiz
        if (ADMIN_ID && chatId.toString() === ADMIN_ID.toString()) {
            if (!user) {
                user = await updateUser(chatId, { name, status: 'approved' });
            } else if (user.status !== 'approved') {
                user = await updateUser(chatId, { status: 'approved' });
            }
            await sendSafeMessage(chatId, "👋 Salom Admin! Tizimga xush kelibsiz.\n\n👇 Quyidagi menyudan foydalanishingiz mumkin:", getMainMenu(chatId));
            return;
        }

        // To'lov xabari va tugmasi
        const payMessage = `👋 Assalomu alaykum, Hurmatli **${safeName}**!\n\n⚠️ Siz botdan foydalanish uchun botning oylik tulovini amalga oshirmagansiz.\n⚠️ Botdan foydalanish uchun admin orqali to'lov qiling !!!\n\n👨‍💼 Admin: @ortiqov_x7`;
        const payOptions = {
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [
                    [{ text: "👨‍💼 Admin bilan bog'lanish", url: "https://t.me/ortiqov_x7" }]
                ]
            }
        };

        if (!user) {
            // Yangi oddiy foydalanuvchi
            user = await updateUser(chatId, { name, status: 'pending' });
            
            await sendSafeMessage(chatId, payMessage, payOptions);
            
            // Adminga xabar berish (Inline buttonlar bilan)
            if (ADMIN_ID) {
                try {
                    await sendSafeMessage(ADMIN_ID, `🆕 **Yangi foydalanuvchi ro'yxatdan o'tdi!**\n👤 Ism: ${safeName}\n🆔 ID: \`${chatId}\`\nStatus: Pending (Tasdiqlash kutilmoqda)`, {
                        parse_mode: "Markdown",
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: "✅ Tasdiqlash", callback_data: `admin_approve_${chatId}` }, { text: "🚫 Bloklash", callback_data: `admin_block_${chatId}` }]
                            ]
                        }
                    });
                } catch (e) {
                    console.error("Admin notification error:", e.message);
                }
            }
            return;
        }

        if (user.status === 'blocked') {
            await sendSafeMessage(chatId, payMessage, payOptions);
            return;
        }

        if (user.status === 'pending') {
            await sendSafeMessage(chatId, payMessage, payOptions);
            
            // Adminga qayta eslatma (Inline buttonlar bilan)
            if (ADMIN_ID) {
                try {
                    await sendSafeMessage(ADMIN_ID, `⏳ **Foydalanuvchi hali ham kutmoqda!**\n👤 Ism: ${safeName}\n🆔 ID: \`${chatId}\`\nStatus: Pending`, {
                        parse_mode: "Markdown",
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: "✅ Tasdiqlash", callback_data: `admin_approve_${chatId}` }, { text: "🚫 Bloklash", callback_data: `admin_block_${chatId}` }]
                            ]
                        }
                    });
                } catch (e) {
                     console.error("Admin notification error:", e.message);
                }
            }
            return;
        }

        // Agar tasdiqlangan bo'lsa
        if (user.status === 'approved') {
            // Agar allaqachon sessiya bo'lsa
            if (user.session) {
                 const clicks = user.clicks || 0;

                 await sendSafeMessage(chatId, `👋 Assalomu alaykum, Hurmatli **${safeName}**!\n\n🤖 **Bu bot orqali siz:**\n• 💎 **Avto Almaz** - avtomatik almaz yig'ish\n• 👤 **AvtoUser** - guruhdan foydalanuvchilarni yig'ish\n• 👮 **Admin ID** - guruh adminlarini aniqlash\n• 📣 **Avto Reklama** - foydalanuvchilarga reklama yuborish\n\nBotdan foydalanish uchun menudan tanlang!`, {
                     parse_mode: "Markdown",
                     ...getMainMenu(chatId)
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

            await sendSafeMessage(chatId, "✅ Siz tasdiqlangansiz.\n\nTelegram akkauntingizga kirish uchun **telefon raqamingizni** yuboring (masalan: `+998901234567`).", {
                parse_mode: "Markdown",
                reply_markup: { remove_keyboard: true }
            });
        }
    } catch (e) {
        console.error("Error in /start command:", e);
        try {
             await bot.sendMessage(msg.chat.id, "⚠️ Botda vaqtincha xatolik yuz berdi. Iltimos keyinroq urinib ko'ring.");
        } catch (e2) {}
    }
});

// Admin komandalari
// Admin komandalari (Eski commandlarni saqlab qolamiz, lekin asosiy ish callback orqali bo'ladi)
bot.onText(/\/approve[ _](\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== ADMIN_ID.toString()) return;

    const targetId = parseInt(match[1]);
    const user = await getUser(targetId);
    if (user) {
        await updateUser(targetId, { status: 'approved' });
        await bot.sendMessage(targetId, "🎉 Siz admin tomonidan tasdiqlandingiz!\nEndi **/start** ni bosib ro'yxatdan o'tishingiz mumkin.", { parse_mode: "Markdown" });
        await bot.sendMessage(chatId, `✅ ${user.name} tasdiqlandi!`);
    } else {
        await bot.sendMessage(chatId, "❌ Foydalanuvchi topilmadi!");
    }
});

bot.onText(/\/block[ _](\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== ADMIN_ID.toString()) return;

    const targetId = parseInt(match[1]);
    const user = await getUser(targetId);
    if (user) {
        await updateUser(targetId, { status: 'blocked', session: null });
        if (userClients[targetId]) {
            try {
                await userClients[targetId].disconnect();
                delete userClients[targetId];
            } catch (e) {
                console.error("Disconnect error:", e);
            }
        }

        try {
            // Markdown belgilarni olib tashlaymiz
            const safeName = user.name ? user.name.replace(/[*_`\[\]()]/g, '') : "Foydalanuvchi";
            
            await bot.sendMessage(targetId, `👋 Assalomu alaykum, Hurmatli **${safeName}**!\n\n⚠️ Siz botdan foydalanish uchun botning oylik tulovini amalga oshirmagansiz.\n⚠️ Botdan foydalanish uchun admin orqali to'lov qiling !!!\n\n👨‍💼 Admin: @ortiqov_x7`, { 
                parse_mode: "Markdown",
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "👨‍💼 Admin bilan bog'lanish", url: "https://t.me/ortiqov_x7" }]
                    ]
                }
            });
        } catch (e) {
            console.error(`Could not send block message to user ${targetId}:`, e.message);
        }
        
        await bot.sendMessage(chatId, `⛔️ ${user.name} bloklandi!`);
    } else {
        await bot.sendMessage(chatId, "❌ Foydalanuvchi topilmadi!");
    }
});

bot.onText(/\/unblock[ _](\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== ADMIN_ID.toString()) return;

    const targetId = parseInt(match[1]);
    const user = await getUser(targetId);
    if (user) {
        // Unblock - statusni 'approved' qilamiz, lekin sessiya yo'q bo'ladi
        // Yoki 'pending' qilish kerakmi? Odatda 'approved' mantiqan to'g'ri, lekin sessiya qayta kiritilishi kerak
        // Keling 'approved' qilamiz, user /start bosib telefon raqam kiritadi
        await updateUser(targetId, { status: 'approved' });
        
        await bot.sendMessage(targetId, `🎉 Siz blokdan chiqarildingiz!\nBotdan foydalanish uchun /start buyrug'ini bosing.`, { parse_mode: "Markdown" });
        await bot.sendMessage(chatId, `✅ ${user.name} blokdan chiqarildi!`);
    } else {
        await bot.sendMessage(chatId, "❌ Foydalanuvchi topilmadi!");
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

    // Admin uchun
    if (chatId === ADMIN_ID) {
        bot.sendMessage(chatId, "📋 **Asosiy menyu:**", { parse_mode: "Markdown", ...getMainMenu(chatId) });
        return;
    }

    if (user && user.session && user.status === 'approved') {
        bot.sendMessage(chatId, "📋 **Asosiy menyu:**", { parse_mode: "Markdown", ...getMainMenu(chatId) });
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

const HELP_TEXT = `🧾 **Yordam**

📌 **Funksiyalar:**

💎 **Avto Almaz :**
Guruhlarda almazli tugmalarni avtomatik bosadi.

Avto Almaz Knopkasida Bir marta bosish orqali almazlarni yig'ishni boshlaydi. Agar yana bir marta bosilsa almazlarni yig'ishni to'xtatadi.

👤 **AvtoUser :**
🔗 Guruh linki va limitni kiriting.

Guruhdan foydalanuvchilarni userlarini yig'adi va sizga yuboradi maksimal 1000 ta (yuser yig'ish jarayoni vaqt olishi mumkin iltimos sabirli bo'ling).


👨‍💼 **Avto reyd :**
Guruxga yoki berilgan Userga avto xabar yuboradi.
Matn va Stikerlarni qo'llab quvvatlaydi.

🔗 Guruh linki yoki user va limitni kiriting.

📢 **Avto Reklama :**
Siz botga yuborgan 100 ta yuserga reklama yuboradi.(unutmang 200 ta yuser yuborsangiz ham faqat ularni 100 tasini oladi )

Userlar va reklama matnini kiriting.

📊 **Profil**
Sizning statistikangizni ko'rsatadi.

🔄 **Nomer almashtirish**
Telefon raqamingizni o'zgartirish.

Agar Bot Haqida To'liq Ma'lumot olmoqchi bo'lsangiz murojat qiling : \`@ortiqov_x7\`;`;

// /help komandasi
bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    await sendSafeMessage(chatId, HELP_TEXT, { parse_mode: "Markdown" });
});


// Callback Query Handler (Inline tugmalar uchun)
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    const messageId = query.message.message_id;

    // --- ADMIN HANDLERS ---
    if (chatId === ADMIN_ID) {
        if (data === 'admin_panel') {
            await bot.editMessageText("👨‍💻 **Admin Panel**\n\nQuyidagi bo'limlardan birini tanlang:", {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: "Markdown",
                reply_markup: getAdminMenu().reply_markup
            });
            await bot.answerCallbackQuery(query.id);
            return;
        }

        if (data === 'menu_back_main') {
            await bot.editMessageText("📋 **Asosiy menyu:**", {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: "Markdown",
                reply_markup: getMainMenu(chatId).reply_markup
            });
            await bot.answerCallbackQuery(query.id);
            return;
        }
    }

    if (chatId === ADMIN_ID && data.startsWith('admin_')) {
        if (data === 'admin_stats') {
            const users = await getUsers();
            let totalClicks = 0;
            let approved = 0;
            let blocked = 0;
            let pending = 0;
            
            // Qo'shimcha statistika
            let totalReyds = 0;
            let totalUsersGathered = 0;
            let totalAdsSent = 0;

            users.forEach(u => {
                totalClicks += (u.clicks || 0);
                totalReyds += (u.reydCount || 0);
                totalUsersGathered += (u.usersGathered || 0);
                totalAdsSent += (u.adsCount || 0);

                if (u.status === 'approved') approved++;
                else if (u.status === 'blocked') blocked++;
                else pending++;
            });

            const statsMessage = "📊 **Bot Statistikasi:**\n\n" +
                "👥 Jami foydalanuvchilar: **" + users.length + "**\n" +
                "✅ Tasdiqlanganlar: **" + approved + "**\n" +
                "⏳ Kutilayotganlar: **" + pending + "**\n" +
                "🚫 Bloklanganlar: **" + blocked + "**\n\n" +
                "💎 Jami almazlar: **" + totalClicks + "** ta\n" +
                "⚔️ Jami reydlar: **" + totalReyds + "** ta\n" +
                "👥 Jami yig'ilgan userlar: **" + totalUsersGathered + "** ta\n" +
                "📢 Jami yuborilgan reklamalar: **" + totalAdsSent + "** ta";
            try {
                await bot.editMessageText(statsMessage, {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: "Markdown",
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "🔄 Yangilash", callback_data: "admin_stats" }],
                            [{ text: "🔙 Orqaga", callback_data: "admin_panel" }]
                        ]
                    }
                });
            } catch (e) {}
            await bot.answerCallbackQuery(query.id);
            return;
        }

        if (data === 'admin_all_users' || data === 'admin_pending' || data === 'admin_approved' || data === 'admin_blocked') {
            const users = await getUsers();
            let filteredUsers = [];
            let title = "";

            if (data === 'admin_all_users') {
                filteredUsers = users;
                title = "👥 **Barcha A'zolar:**";
            } else if (data === 'admin_pending') {
                filteredUsers = users.filter(u => u.status === 'pending');
                title = "⏳ **Kutilayotganlar:**";
            } else if (data === 'admin_approved') {
                filteredUsers = users.filter(u => u.status === 'approved');
                title = "✅ **Tasdiqlanganlar:**";
            } else if (data === 'admin_blocked') {
                filteredUsers = users.filter(u => u.status === 'blocked');
                title = "🚫 **Bloklanganlar:**";
            }

            if (filteredUsers.length === 0) {
                await bot.answerCallbackQuery(query.id, { text: "📂 Ro'yxat bo'sh!", show_alert: true });
                return;
            }

            let listMessage = title + "\n\n";
            const recentUsers = filteredUsers.slice(-20).reverse(); 

            recentUsers.forEach(u => {
                const statusIcon = u.status === 'approved' ? 'OK' : (u.status === 'blocked' ? 'NO' : 'WT');

                
                if (u.status === 'pending') {
                    listMessage += "👉 /approve_" + u.chatId + " | /block_" + u.chatId + "\n"; 
                } else if (u.status === 'approved') {
                    listMessage += "👉 /block_" + u.chatId + "\n";
                } else if (u.status === 'blocked') {
                    listMessage += "👉 /unblock_" + u.chatId + "\n";
                }
            });
            
            listMessage += "\njami: " + filteredUsers.length + " ta";

            try {
                await bot.editMessageText(listMessage, {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: "Markdown",
                    reply_markup: getAdminMenu().reply_markup
                });
            } catch (e) {}
            await bot.answerCallbackQuery(query.id);
            return;
        }

        if (data.startsWith('admin_approve_')) {
            const targetId = parseInt(data.split('_')[2]);
            const user = await getUser(targetId);
            if (user) {
                await updateUser(targetId, { status: 'approved' });
                await sendSafeMessage(targetId, "🎉 Siz admin tomonidan tasdiqlandingiz!\nEndi **/start** ni bosib ro'yxatdan o'tishingiz mumkin.", { parse_mode: "Markdown" });
                
                await bot.answerCallbackQuery(query.id, { text: "✅ " + user.name + " tasdiqlandi!" });
                try {
                    const msg = "OK **Foydalanuvchi tasdiqlandi!**\nIsm: " + escapeMarkdown(user.name) + "\nID: " + targetId + "\nStatus: Approved";
                    await bot.editMessageText(msg, {
                        chat_id: chatId,
                        message_id: messageId,
                        parse_mode: "Markdown"
                    });
                } catch (e) {}
                await bot.sendMessage(chatId, "👇 Bosh menyu:", getAdminMenu());
            } else {
                await bot.answerCallbackQuery(query.id, { text: "❌ Foydalanuvchi topilmadi!", show_alert: true });
            }
            return;
        }

        if (data.startsWith('admin_block_')) {
            const targetId = parseInt(data.split('_')[2]);
            const user = await getUser(targetId);
            if (user) {
                await updateUser(targetId, { status: 'blocked', session: null });
                if (userClients[targetId]) {
                    userClients[targetId].disconnect();
                    delete userClients[targetId];
                }

                const blockMsg = "You are blocked. Contact Admin.";
                await sendSafeMessage(targetId, blockMsg, { 
                    parse_mode: "Markdown",
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "👨‍💼 Admin bilan bog'lanish", url: "https://t.me/ortiqov_x7" }]
                        ]
                    }
                });

                await bot.answerCallbackQuery(query.id, { text: "NO " + user.name + " bloklandi!" });
                try {
                    const blockText = "Foydalanuvchi bloklandi.\nIsm: " + escapeMarkdown(user.name) + "\nID: " + targetId;
                    await bot.editMessageText(blockText, {
                        chat_id: chatId,
                        message_id: messageId,
                        parse_mode: "Markdown"
                    });
                } catch (e) {}
                await bot.sendMessage(chatId, "👇 Bosh menyu:", getAdminMenu());
            } else {
                await bot.answerCallbackQuery(query.id, { text: "❌ Foydalanuvchi topilmadi!", show_alert: true });
            }
            return;
        }
    }

    // Tugmani bosganda soatni aylantirib turish (loading...)
    try {
        await bot.answerCallbackQuery(query.id);
    } catch(e) {}

    // --- MENYU HANDLERS ---
    if (data === "menu_almaz") {
        if (userStates[chatId]) delete userStates[chatId];
        const user = await getUser(chatId);
        if (user && user.session) {
             // Statusni tekshirish (default: true)
             if (avtoAlmazStates[chatId] === undefined) {
                 avtoAlmazStates[chatId] = true;
             }
             const isActive = avtoAlmazStates[chatId];
             const statusText = isActive ? "[ON] Yoqilgan" : "[OFF] O'chirilgan";
             const btnText = isActive ? "[OFF] O'chirish" : "[ON] Yoqish";

             bot.sendMessage(chatId, "**Avto Almaz**\n\nBot guruhlardagi 'Olish' tugmalarini o'zi bosadi.\n\nHolati: " + statusText, { 
                 parse_mode: "Markdown",
                 reply_markup: {
                     inline_keyboard: [
                         [{ text: btnText, callback_data: "almaz_toggle" }],
                         [{ text: "🔙 Asosiy menyu", callback_data: "menu_back_main" }]
                     ]
                 }
             });
        } else {
             bot.sendMessage(chatId, "❌ Bu bo'limga kirish uchun avval tizimga kiring (/start).");
        }
    }

    else if (data === "almaz_toggle") {
        if (avtoAlmazStates[chatId] === undefined) {
            avtoAlmazStates[chatId] = true;
        }
        avtoAlmazStates[chatId] = !avtoAlmazStates[chatId];
        
        const isActive = avtoAlmazStates[chatId];
        const statusText = isActive ? "[ON] Yoqilgan" : "[OFF] O'chirilgan";
        const btnText = isActive ? "[OFF] O'chirish" : "[ON] Yoqish";
        
        try {
            await bot.editMessageText("**Avto Almaz**\n\nBot guruhlardagi 'Olish' tugmalarini o'zi bosadi.\n\nHolati: " + statusText, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: "Markdown",
                reply_markup: {
                    inline_keyboard: [
                        [{ text: btnText, callback_data: "almaz_toggle" }],
                        [{ text: "🔙 Asosiy menyu", callback_data: "menu_back_main" }]
                    ]
                }
            });
            const alertText = "Avto Almaz " + (isActive ? "yoqildi" : "o'chirildi") + "!";
            await bot.answerCallbackQuery(query.id, { text: alertText });
        } catch (e) {
            await bot.sendMessage(chatId, "Avto Almaz " + (isActive ? "yoqildi" : "o'chirildi") + "!");
        }
    }

    else if (data === "menu_avtouser") {
        if (userStates[chatId]) delete userStates[chatId]; 
        const user = await getUser(chatId);
        
        if (!user || user.status !== 'approved' || !userClients[chatId]) {
            bot.sendMessage(chatId, "❌ **AvtoUser** ishlashi uchun avval hisobingizga kiring.\n\n/start ni bosing va telefon raqamingizni kiriting.", { parse_mode: "Markdown" });
            return;
        }

        userStates[chatId] = { step: 'WAITING_AVTOUSER_LINK' };
        bot.sendMessage(chatId, "🔗 Guruh linkini yuboring:", { parse_mode: "Markdown" });
    }

    else if (data === "menu_reyd") {
        if (userStates[chatId]) delete userStates[chatId];
        const user = await getUser(chatId);
        if (!user || user.status !== 'approved' || !userClients[chatId]) {
            bot.sendMessage(chatId, "❌ Bu funksiyadan foydalanish uchun avval ro'yxatdan o'ting va hisobingizga kiring.");
            return;
        }
        userStates[chatId] = { step: 'WAITING_REYD_TYPE' };
        bot.sendMessage(chatId, "⚔️ **Avto Reyd**\n\nNishon turini tanlang:", {
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [
                    [{ text: "👥 Guruh", callback_data: "reyd_group" }, { text: "👤 User", callback_data: "reyd_user" }],
                    [{ text: "🔙 Bekor qilish", callback_data: "reyd_cancel" }]
                ]
            }
        });
    }

    else if (data === "menu_reklama") {
        if (userStates[chatId]) delete userStates[chatId];
        const user = await getUser(chatId);
        if (!user || user.status !== 'approved' || !userClients[chatId]) {
            bot.sendMessage(chatId, "❌ Bu funksiyadan foydalanish uchun avval ro'yxatdan o'ting va hisobingizga kiring.");
            return;
        }
    
        userStates[chatId] = { step: 'WAITING_REK_USERS' };
        bot.sendMessage(chatId, "🚀 **Avto Reklama**\n\nIltimos, reklama yuboriladigan foydalanuvchilar username-larini yuboring.\n\n_Misol:_\n@user1\n@user2\n@user3\n\n(Maksimum 100 ta username)", { parse_mode: "Markdown" });
    }

    else if (data === "menu_profile") {
        if (userStates[chatId]) delete userStates[chatId];
        const user = await getUser(chatId);
        if (!user) {
            bot.sendMessage(chatId, "[X] Siz ro'yxatdan o'tmagansiz. /start ni bosing.");
            return;
        }
        const statusIcon = user.status === 'approved' ? '[OK] Tasdiqlangan' : (user.status === 'blocked' ? '[NO] Bloklangan' : '[WT] Kutilmoqda');
        const sessionStatus = userClients[chatId] ? '[ON] Onlayn' : '[OFF] Offlayn';
        
        let message = "**Sizning Profilingiz:**\n\n";
        message += "Ism: " + escapeMarkdown(user.name) + "\n";
        message += "ID: " + user.chatId + "\n";
        message += "Holat: " + statusIcon + "\n";
        message += "Sessiya: " + sessionStatus + "\n\n";
        
        message += "Reydlar soni: " + (user.reydCount || 0) + " ta\n";
        message += "Yig'ilgan userlar: " + (user.usersGathered || 0) + " ta\n";
        message += "Yuborilgan reklamalar: " + (user.adsCount || 0) + " ta\n";
        message += "To'plangan almazlar: " + (user.clicks || 0) + " ta\n\n";

        message += "Ro'yxatdan o'tgan sana: " + new Date(user.joinedAt).toLocaleDateString();

        // Agar eski xabar bo'lsa edit qilamiz, aks holda yangi jo'natamiz
        try {
            await bot.editMessageText(message, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: "Markdown",
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "🔄 Yangilash", callback_data: "profile_reset" }],
                        [{ text: "🔙 Asosiy menyu", callback_data: "menu_back_main" }]
                    ]
                }
            });
        } catch (e) {
            // Agar edit o'xshamasa (masalan xabar o'zgarmagan bo'lsa yoki eski xabar bo'lmasa)
            if (!e.message.includes('message is not modified')) {
                await sendSafeMessage(chatId, message, {
                    parse_mode: "Markdown",
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "🔄 Yangilash", callback_data: "profile_reset" }],
                            [{ text: "🔙 Asosiy menyu", callback_data: "menu_back_main" }]
                        ]
                    }
                });
            }
        }
    }

    else if (data === "profile_reset") {
        if (userStates[chatId]) delete userStates[chatId];
        
        // Statistikani nollash
        await updateUser(chatId, { 
            reydCount: 0, 
            usersGathered: 0, 
            adsCount: 0, 
            clicks: 0 
        });

        const user = await getUser(chatId);
        if (!user) return;

        const statusIcon = user.status === 'approved' ? '[OK] Tasdiqlangan' : (user.status === 'blocked' ? '[NO] Bloklangan' : '[WT] Kutilmoqda');
        const sessionStatus = userClients[chatId] ? '[ON] Onlayn' : '[OFF] Offlayn';
        
        let message = "**Sizning Profilingiz:**\n\n";
        message += "Ism: " + escapeMarkdown(user.name) + "\n";
        message += "ID: " + user.chatId + "\n";
        message += "Holat: " + statusIcon + "\n";
        message += "Sessiya: " + sessionStatus + "\n\n";
        
        message += "Reydlar soni: " + (user.reydCount || 0) + " ta\n";
        message += "Yig'ilgan userlar: " + (user.usersGathered || 0) + " ta\n";
        message += "Yuborilgan reklamalar: " + (user.adsCount || 0) + " ta\n";
        message += "To'plangan almazlar: " + (user.clicks || 0) + " ta\n\n";

        message += "Ro'yxatdan o'tgan sana: " + new Date(user.joinedAt).toLocaleDateString();

        try {
            await bot.editMessageText(message, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: "Markdown",
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "🔄 Yangilash", callback_data: "profile_reset" }],
                        [{ text: "🔙 Asosiy menyu", callback_data: "menu_back_main" }]
                    ]
                }
            });
            await bot.answerCallbackQuery(query.id, { text: "🔄 Statistikalar tozalandi!" });
        } catch (e) {
            if (!e.message.includes('message is not modified')) {
                await sendSafeMessage(chatId, message, {
                    parse_mode: "Markdown",
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "🔄 Yangilash", callback_data: "profile_reset" }],
                            [{ text: "🔙 Asosiy menyu", callback_data: "menu_back_main" }]
                        ]
                    }
                });
            }
        }
    }

    else if (data === "menu_back_main") {
        if (userStates[chatId]) delete userStates[chatId];
        // Asosiy menyuga qaytish uchun xabarni yangilaymiz
        try {
            await bot.editMessageText("📋 **Asosiy menyu:**", {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: "Markdown",
                ...getMainMenu()
            });
        } catch (e) {
             if (!e.message.includes('message is not modified')) {
                 await sendSafeMessage(chatId, "📋 **Asosiy menyu:**", { parse_mode: "Markdown", ...getMainMenu() });
             }
        }
    }

    else if (data === "menu_logout") {
        if (userStates[chatId]) delete userStates[chatId];
        const user = await getUser(chatId);
        if (user) {
            await updateUser(chatId, { session: null });
            if (userClients[chatId]) {
                try {
                    userClients[chatId].disconnect();
                    userClients[chatId].destroy();
                    delete userClients[chatId];
                } catch (e) { console.error("Disconnect error:", e); }
            }
            if (userStates[chatId]) delete userStates[chatId];
            if (loginPromises[chatId]) delete loginPromises[chatId];

            await sendSafeMessage(chatId, "🔄 **Tizimdan chiqildi.**\n\nBoshqa raqam bilan kirish uchun /start ni bosing.", { 
                parse_mode: "Markdown",
                reply_markup: { remove_keyboard: true } // Eski keyboardni o'chiramiz (agar qolgan bo'lsa)
            });
        } else {
            bot.sendMessage(chatId, "❌ Siz tizimga kirmagansiz.");
        }
    }

    else if (data === "menu_help") {
        await sendSafeMessage(chatId, HELP_TEXT, { parse_mode: "Markdown" });
    }

    // --- REYD HANDLERS ---
    else if (data === "reyd_group") {
        userStates[chatId] = { step: 'WAITING_REYD_TARGET', type: 'group' };
        bot.sendMessage(chatId, "👥 **Guruh Reyd**\n\nGuruh linkini yoki username-ni yuboring (masalan: @guruh yoki https://t.me/...):", { parse_mode: "Markdown" });
    }
    else if (data === "reyd_user") {
        userStates[chatId] = { step: 'WAITING_REYD_TARGET', type: 'user' };
        bot.sendMessage(chatId, "👤 **User Reyd**\n\nFoydalanuvchi username-ni yuboring (masalan: @user):", { parse_mode: "Markdown" });
    }
    else if (data === "reyd_cancel") {
        delete userStates[chatId];
        bot.sendMessage(chatId, "❌ Reyd bekor qilindi.", getMainMenu());
    }

    else if (data === "reyd_start") {
        if (userStates[chatId]) {
            const state = userStates[chatId];
            bot.sendMessage(chatId, "🚀 Reyd boshlandi!", {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "⏸ Pauza", callback_data: "reyd_pause" }, { text: "⏹ To'xtatish", callback_data: "reyd_stop" }]
                    ]
                }
            });
            startReyd(chatId, userClients[chatId], state.target, state.count, state.content, state.contentType, state.entities);
            delete userStates[chatId];
        } else {
            bot.sendMessage(chatId, "⚠️ Sessiya topilmadi. Qaytadan boshlang.");
        }
    }

    // --- REYD CONTROL ---
    else if (data === "reyd_stop") {
        if (reydSessions[chatId]) {
            reydSessions[chatId].status = 'stopped';
            bot.sendMessage(chatId, "🛑 Reyd to'xtatildi.", getMainMenu());
            try {
                bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId });
            } catch(e) {}
        } else {
            bot.sendMessage(chatId, "⚠️ Faol reyd topilmadi.");
        }
    }
    else if (data === "reyd_pause") {
        if (reydSessions[chatId]) {
            reydSessions[chatId].status = 'paused';
            bot.sendMessage(chatId, "⏸ Reyd pauza qilindi. Davom ettirish uchun tugmani bosing.", {
                reply_markup: {
                    inline_keyboard: [[{ text: "▶️ Davom ettirish", callback_data: "reyd_resume" }]]
                }
            });
        }
    }
    else if (data === "reyd_resume") {
        if (reydSessions[chatId]) {
            reydSessions[chatId].status = 'active';
            bot.sendMessage(chatId, "▶️ Reyd davom etmoqda...");
        }
    }

    // --- REKLAMA CONTROL ---
    else if (data === "rek_cancel") {
        delete userStates[chatId];
        bot.sendMessage(chatId, "❌ Reklama bekor qilindi.", getMainMenu());
    }

    else if (data === "rek_start") {
        if (userStates[chatId]) {
            const state = userStates[chatId];
            bot.sendMessage(chatId, "🚀 Reklama yuborish boshlandi...", { 
                reply_markup: { 
                    inline_keyboard: [
                        [{ text: "⏸ Pauza", callback_data: "rek_pause" }, { text: "⏹ To'xtatish", callback_data: "rek_stop" }]
                    ]
                } 
            });
            delete userStates[chatId]; // State ni tozalaymiz, lekin jarayon davom etadi
            
            // Reklama sessiyasini yaratish
            reklamaSessions[chatId] = {
                status: 'active',
                users: state.rekUsers,
                content: state.rekContent,
                contentType: state.rekContentType,
                entities: state.rekEntities,
                currentIndex: 0,
                errorState: false
            };
            
            startReklama(chatId, userClients[chatId], state.rekUsers, state.rekContent, state.rekContentType, state.rekEntities);
        } else {
             bot.sendMessage(chatId, "⚠️ Sessiya topilmadi. Qaytadan boshlang.");
        }
    }

    else if (data === "rek_stop") {
        if (reklamaSessions[chatId]) {
            reklamaSessions[chatId].status = 'stopped';
            
            // Faylni o'chirish
            const session = reklamaSessions[chatId];
            if (session.contentType === 'sticker' && session.content) {
                try {
                    if (fs.existsSync(session.content)) fs.unlinkSync(session.content);
                } catch (e) {}
            }
            delete reklamaSessions[chatId];
            
            bot.sendMessage(chatId, "🛑 Reklama to'xtatildi.", getMainMenu());
            // Eski xabardagi tugmalarni o'chirish
            try {
                bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId });
            } catch(e) {}
        }
    }
    else if (data === "rek_pause") {
        if (reklamaSessions[chatId]) {
            reklamaSessions[chatId].status = 'paused';
            bot.sendMessage(chatId, "⏸ Reklama pauza qilindi. Davom ettirish uchun tugmani bosing.", {
                reply_markup: {
                    inline_keyboard: [[{ text: "▶️ Davom ettirish", callback_data: "rek_resume" }]]
                }
            });
        }
    }
    else if (data === "rek_resume") {
        if (reklamaSessions[chatId]) {
            reklamaSessions[chatId].status = 'active';
            const session = reklamaSessions[chatId];
            
            bot.sendMessage(chatId, "Reklama davom ettirilmoqda... (Qolganlar: " + (session.users.length - session.currentIndex) + ")");
            
            if (session.errorState) {
                session.errorState = false;
                startReklama(chatId, userClients[chatId], session.users, session.content, session.contentType, session.entities, session.currentIndex);
            }
        }
    }
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
    // (O'chirildi - Inline tugmalarga o'tkazildi)

    if (text.startsWith('/')) return;

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
                bot.sendMessage(chatId, "Maksimum 100 ta username mumkin. Siz " + usernames.length + " ta yubordingiz.");
                return;
            }

            state.rekUsers = usernames;
            state.step = 'WAITING_REK_CONTENT';
            bot.sendMessage(chatId, "**" + usernames.length + " ta** foydalanuvchi qabul qilindi.\n\nEndi reklama matnini yoki stikerni yuboring:", { parse_mode: "Markdown" });
            return;
        }

        if (state.step === 'WAITING_REK_CONTENT') {
            if (msg.sticker) {
                // Stikerni yuklab olamiz
                try {
                    const fileId = msg.sticker.file_id;
                    const tempDir = './temp';
                    if (!fs.existsSync(tempDir)) {
                        fs.mkdirSync(tempDir, { recursive: true });
                    }
                    
                    const savedPath = await bot.downloadFile(fileId, tempDir);
                    
                    state.rekContent = savedPath;
                    state.rekContentType = 'sticker';
                    state.rekContentView = '[Stiker]';
                } catch (e) {
                    console.error("Stiker yuklashda xatolik:", e);
                    bot.sendMessage(chatId, "⚠️ Stikerni yuklab olishda xatolik bo'ldi. Iltimos, boshqa stiker yoki matn yuboring.");
                    return;
                }
            } else if (text) {
                state.rekContent = text;
                state.rekContentType = 'text';
                state.rekContentView = text;
                state.rekEntities = msg.entities; // Entitiesni saqlaymiz (Premium emojilar uchun)
            } else {
                 bot.sendMessage(chatId, "⚠️ Iltimos, matn yoki stiker yuboring.");
                 return;
            }

            // state.step = 'WAITING_REK_CONFIRM'; // Inline buttonda kerak emas
            bot.sendMessage(chatId, "**Reklama:**\n\n" + state.rekContentView + "\n\n**Qabul qiluvchilar:** " + state.rekUsers.length + " ta\n\nBoshlashni tasdiqlaysizmi?", {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "✅ Boshlash", callback_data: "rek_start" }],
                        [{ text: "❌ Bekor qilish", callback_data: "rek_cancel" }]
                    ]
                }
            });
            return;
        }

        // WAITING_REK_CONFIRM o'chirildi (Inline button orqali ishlaydi)



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
            if (limit > 10000) limit = 10000;

            // Process started...


            // Asosiy funksiyani chaqirish
            startAvtoUser(chatId, userClients[chatId], state.targetLink, limit);
            
            delete userStates[chatId];
            return;
        }

        // --- AVTO REYD LOGIKASI ---
        // (WAITING_REYD_TYPE endi inline button orqali ishlaydi)


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
                state.entities = msg.entities; // Entitiesni saqlaymiz (Premium emojilar uchun)
            } else {
                 bot.sendMessage(chatId, "⚠️ Iltimos, matn yoki stiker yuboring.");
                 return;
            }
            
            // state.step = 'WAITING_REYD_CONFIRM'; // Inline buttonda kerak emas
            bot.sendMessage(chatId, "**Reyd ma'lumotlari:**\n\nNishon: " + state.target + "\nSoni: " + state.count + "\nXabar: " + state.contentView + "\n\nBoshlashni tasdiqlaysizmi?", {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "🚀 Boshlash", callback_data: "reyd_start" }],
                        [{ text: "🔙 Bekor qilish", callback_data: "reyd_cancel" }]
                    ]
                }
            });
            return;
        }

        // WAITING_REYD_CONFIRM o'chirildi (Inline button orqali ishlaydi)

        // --- LOGIN LOGIKASI ---
        // 1. Telefon raqam qabul qilish
        if (state.step === 'WAITING_PHONE') {
            // Raqamni tozalash va formatlash
            let phone = text.replace(/\s+/g, '').replace(/[()]/g, '');
            if (!phone.startsWith('+')) {
                phone = '+' + phone;
            }
            state.phoneNumber = phone;
            
            bot.sendMessage(chatId, "Raqam: " + state.phoneNumber + "\nUlanmoqda... Kod yuborilmoqda...");

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
                    console.log("[" + chatId + "] Kod so'ralmoqda...");
                    state.step = 'WAITING_CODE';
                    userStates[chatId] = state;
                    bot.sendMessage(chatId, "Kod yuborildi! Telegramdan kelgan kodni 12.345 ko'rinishida kiriting:", { parse_mode: "Markdown" });
                    return new Promise((resolve) => { loginPromises[chatId].resolveCode = resolve; });
                },
                password: async () => {
                    console.log("[" + chatId + "] Parol so'ralmoqda...");
                    state.step = 'WAITING_PASSWORD';
                    userStates[chatId] = state;
                    bot.sendMessage(chatId, "2 Bosqichli parolni yuboring:", { parse_mode: "Markdown" });
                    return new Promise((resolve) => { loginPromises[chatId].resolvePassword = resolve; });
                },
                onError: async (err) => {
                    console.error("[" + chatId + "] Client error:", err);
                    
                    // Loopni to'xtatish uchun darhol sessiyani tozalaymiz
                    if (loginPromises[chatId]) delete loginPromises[chatId];
                    if (userStates[chatId]) delete userStates[chatId];
                    
                    // Clientni to'xtatish
                    try {
                        await client.disconnect();
                        await client.destroy();
                    } catch (e) { console.error("Disconnect error:", e); }

                    if (err.message && err.message.includes('PHONE_CODE_INVALID')) {
                          bot.sendMessage(chatId, "Kod noto'g'ri kiritildi. Iltimos, **/start** bosib, raqamingizni va yangi kodni qaytadan kiriting.", { parse_mode: "Markdown" });
                     } else if (err.message && err.message.includes('PHONE_NUMBER_INVALID')) {
                          bot.sendMessage(chatId, "Telefon raqam noto'g'ri. /start bosib qayta urinib ko'ring.");
                     } else if (err.message && err.message.includes('wait') && err.message.includes('seconds')) {
                          const seconds = err.message.match(/\d+/)[0];
                          bot.sendMessage(chatId, "Telegram sizni vaqtincha blokladi. Iltimos, **" + seconds + " soniya** kuting va keyin /start bosing.");
                     } else {
                          bot.sendMessage(chatId, "Xatolik yuz berdi: " + err.message + ". /start bosib qayta urinib ko'ring.");
                     }
                 },
            }).then(async () => {
                console.log("[" + chatId + "] Client connected successfully!");
                const session = client.session.save();
                
                // Bazaga sessiyani saqlash
                await updateUser(chatId, { session: session });
                
                bot.sendMessage(chatId, "**Muvaffaqiyatli kirdingiz!** Userbot ishga tushdi.", { parse_mode: "Markdown" });
                
                state.step = 'LOGGED_IN';
                userStates[chatId] = state;
                
                // Userbotni saqlash va ishga tushirish
                userClients[chatId] = client;
                startUserbot(client, chatId);

            }).catch(async (e) => {
                 console.error("[" + chatId + "] Start error:", e);
                 
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
                    bot.sendMessage(chatId, "Telegram sizni vaqtincha blokladi. Iltimos, **" + seconds + " soniya** kuting va keyin /start bosing.");
                } else {
                    bot.sendMessage(chatId, "Xatolik: " + e.message + ". /start ni bosing.");
                }
           });
       }
       // 2. Kodni qabul qilish
       else if (state.step === 'WAITING_CODE') {
           const rawCode = text;
           const code = rawCode.replace(/\D/g, ''); 
           console.log("[" + chatId + "] Kod qabul qilindi: " + code + " (Raw: " + rawCode + ")");
           
           if (loginPromises[chatId] && loginPromises[chatId].resolveCode) {
               bot.sendMessage(chatId, "🔄 Kod tekshirilmoqda...");
               loginPromises[chatId].resolveCode(code);
           } else {
               console.warn("[" + chatId + "] Kod keldi, lekin promise yo'q!");
                bot.sendMessage(chatId, "⚠️ Xatolik: Sessiya topilmadi yoki eskirgan. Iltimos, /start bosib boshidan boshlang.");
                delete userStates[chatId];
            }
        }
        // 3. Parolni qabul qilish
        else if (state.step === 'WAITING_PASSWORD') {
            const password = text.trim();
            console.log("[" + chatId + "] Parol qabul qilindi.");
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
        bot.sendMessage(chatId, "Xatolik: " + error.message);
    }
});




async function startAvtoUser(chatId, client, link, limit) {
    try {
        bot.sendMessage(chatId, "⏳ Yig'ilmoqda...(iltimos kuting bu bir nechta vaqt olishi mumkin)");
        
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
                        if (e.message && (e.message.includes('USER_ALREADY_PARTICIPANT') || e.message.includes('ALREADY_PARTICIPANT'))) {
                            console.log("User already in group. Resolving entity...");
                            // Agar allaqachon a'zo bo'lsa, checkChatInvite orqali ma'lumot olishga harakat qilamiz
                            try {
                                const check = await client.invoke(new Api.messages.CheckChatInvite({ hash: hash }));
                                // check.chat bu yerda ChatInvite (title bor) yoki Channel/Chat bo'lishi mumkin
                                
                                if (check.className === 'ChatInviteAlready' && check.chat) {
                                    entity = check.chat;
                                } else if (check.title) {
                                    // Agar ChatInvite qaytsa (lekin biz a'zo bo'lsak), title orqali qidiramiz
                                    console.log("Searching for chat by title: " + check.title);
                                    
                                    // Dialoglardan qidirish (ko'proq limit bilan)
                                    const dialogs = await client.getDialogs({ limit: 200 });
                                    const found = dialogs.find(d => d.title === check.title || d.name === check.title);
                                    
                                    if (found) {
                                        entity = found.entity;
                                        console.log("Entity found in dialogs:", entity.title);
                                    } else {
                                        // Agar 200 ta ichida topilmasa, iteratsiya qilib ko'ramiz (sekinroq lekin aniqroq)
                                        console.log("Deep searching in dialogs...");
                                        for await (const dialog of client.iterDialogs({ limit: 500 })) {
                                             if (dialog.title === check.title || dialog.name === check.title) {
                                                entity = dialog.entity;
                                                console.log("Entity found in deep search:", entity.title);
                                                break;
                                            }
                                        }
                                    }
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
            bot.sendMessage(chatId, "Xatolik: Guruhga kirib bo'lmadi.\nLink noto'g'ri yoki bot spamga tushgan bo'lishi mumkin.\n\nDetal: " + e.message);
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
        // bot.sendMessage(chatId, "<b>" + safeTitle + "</b> guruhiga ulanildi.\n\n2. A'zolar ro'yxati shakllantirilmoqda...", { parse_mode: "HTML" });

        // 2. MA'LUMOTLARNI YIG'ISH
        let admins = [];
        let members = [];
        const uniqueUsernames = new Set();
        
        try {
            // ADMINLARNI OLISH (YANGI QO'SHILGAN)
            try {
                console.log("Fetching admins...");
                const adminParticipants = await client.getParticipants(entity, {
                    filter: new Api.ChannelParticipantsAdmins(),
                    limit: 100 // Adminlar ko'p bo'lmaydi
                });
                
                for (const participant of adminParticipants) {
                    if (participant.username && !uniqueUsernames.has(participant.username)) {
                        uniqueUsernames.add(participant.username);
                        admins.push("@" + participant.username);
                    }
                }
                console.log("Admins found: " + admins.length);
            } catch (e) {
                console.error("Admin fetch error:", e);
                // Adminlarni olishda xatolik bo'lsa ham davom etamiz
            }

            // FAQAT HISTORY SCAN (Xabarlar tarixidan yig'ish)
            if (members.length < limit) {
                try {
                    console.log("Starting History Scan via iterMessages (Target: " + limit + " members)...");
                    
                    const historyMax = 10000; // 10k xabargacha ko'rish
                    
                    for await (const message of client.iterMessages(entity, { limit: historyMax })) {
                        if (members.length >= limit) break;
                        
                        // Xabar egasini aniqlash
                        let user = message.sender; // GramJS avtomatik keshlashdan oladi
                        
                        // getSender() olib tashlandi - tezlik uchun
                        // Agar user keshda bo'lmasa, uni alohida so'rov bilan olish juda sekin.
                        // Shuning uchun faqat keshda borlarini olamiz.

                        if (user) {
                            // Faqat User tipidagilar (Channel/Chat emas)
                            if (user.className !== 'User' && user.className !== 'PeerUser') continue;

                            if (user.deleted || user.bot || user.isSelf) continue;
                            
                            if (user.username && !uniqueUsernames.has(user.username)) {
                                uniqueUsernames.add(user.username);
                                members.push("@" + user.username);
                            }
                        }
                    }

                } catch (e) {
                    console.log("History scan failed:", e.message);
                }
            }
        } catch (e) {
            console.error("Member fetch error:", e);
            bot.sendMessage(chatId, "A'zolarni olishda xatolik: " + e.message);
            return;
        }

        if (members.length === 0 && admins.length === 0) {
            bot.sendMessage(chatId, "❌ Hech qanday foydalanuvchi topilmadi (username borlar). Guruh a'zolari yashirilgan bo'lishi mumkin.");
            return;
        }

        // 3. NATIJANI YUBORISH (ALOHIDA XABARLARDA)
        const total = admins.length + members.length;
        
        // 1. Summary Message
        const summaryMessage = "🏁 **NATIJA:**\n\n👑 **Adminlar:** " + admins.length + " ta\n👥 **Azolar:** " + members.length + " ta\n📦 **Jami:** " + total + " ta";
        await bot.sendMessage(chatId, summaryMessage, { parse_mode: "Markdown" });

        // Helper: Ro'yxatni bo'laklab yuborish
        const sendListMessage = async (header, items) => {
             const MAX_LENGTH = 4000;
             let currentMessage = header + "\n\n";
             
             for (const item of items) {
                 // Agar xabar limiti oshsa, yuboramiz va yangisini boshlaymiz
                 if (currentMessage.length + item.length + 1 > MAX_LENGTH) {
                     await bot.sendMessage(chatId, currentMessage, { parse_mode: "HTML" });
                     currentMessage = header + " (davomi)...\n\n" + item;
                 } else {
                     currentMessage += "\n" + item;
                 }
             }
             // Qolgan qismini yuborish
             if (currentMessage !== header + "\n\n") {
                 await bot.sendMessage(chatId, currentMessage, { parse_mode: "HTML" });
             }
        };

        // 2. Adminlar Message
        if (admins.length > 0) {
            await sendListMessage("<b>👑 ADMINLAR USERNAMELARI:</b>", admins);
        }

        // 3. Azolar Message
        if (members.length > 0) {
            await sendListMessage("<b>👥 AZOLAR USERNAMELARI:</b>", members);
        }

        // 4. Tugadi Message
        await bot.sendMessage(chatId, "✅ Tugadi", { parse_mode: "HTML", ...getMainMenu(chatId) });

        // Statistikani yangilash
        await User.findOneAndUpdate({ chatId }, { $inc: { usersGathered: total } });

    } catch (err) {
        console.error("General AvtoUser error:", err);
        bot.sendMessage(chatId, "Kutilmagan xatolik: " + err.message);
    }
}

async function startReyd(chatId, client, target, count, content, contentType, entities) {
    try {
        reydSessions[chatId] = { status: 'active', count: 0, target: target };
        let sent = 0;
        let errors = 0;

        // GramJS uchun entities konvertatsiya qilish (faqat text bo'lsa)
        let messageEntities = null;
        if (contentType === 'text' && entities && entities.length > 0) {
            try {
                messageEntities = entities.map(e => {
                    if (e.type === 'bold') return new Api.MessageEntityBold({ offset: e.offset, length: e.length });
                    if (e.type === 'italic') return new Api.MessageEntityItalic({ offset: e.offset, length: e.length });
                    if (e.type === 'code') return new Api.MessageEntityCode({ offset: e.offset, length: e.length });
                    if (e.type === 'pre') return new Api.MessageEntityPre({ offset: e.offset, length: e.length, language: e.language || '' });
                    if (e.type === 'text_link') return new Api.MessageEntityTextUrl({ offset: e.offset, length: e.length, url: e.url });
                    if (e.type === 'url') return new Api.MessageEntityUrl({ offset: e.offset, length: e.length });
                    if (e.type === 'custom_emoji') {
                        return new Api.MessageEntityCustomEmoji({
                            offset: e.offset,
                            length: e.length,
                            documentId: BigInt(e.custom_emoji_id) 
                        });
                    }
                    return null;
                }).filter(e => e !== null);
            } catch (err) {
                console.error("Entity conversion error in Reyd:", err);
            }
        }

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
            bot.sendMessage(chatId, "Guruhni aniqlab bo'lmadi yoki qo'shilib bo'lmadi: " + e.message);
            // Davom etishga harakat qilamiz (balki target to'g'ridir)
        }

        bot.sendMessage(chatId, "Reyd boshlanmoqda: " + target + " ga " + count + " ta xabar.");

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
                    await client.sendMessage(finalTarget, { 
                        message: content,
                        formattingEntities: messageEntities
                    });
                }
                sent++;
            } catch (e) {
                console.error("Reyd error (" + i + "):", e);
                errors++;
                
                // FloodWait xatoligini avtomatik hal qilish
                if (e.seconds) {
                    const waitTime = e.seconds;
                    bot.sendMessage(chatId, "Telegram cheklovi (FloodWait): " + waitTime + " sekund kuting...");
                    // Kutish vaqti
                    await new Promise(resolve => setTimeout(resolve, (waitTime + 2) * 1000));
                    // Xabarni qayta yuborish uchun i ni bittaga kamaytiramiz
                    i--;
                    continue;
                }

                // Agar boshqa turdagi FloodWait bo'lsa (message string orqali)
                if (e.message && e.message.includes('FLOOD_WAIT')) {
                     // Raqamni ajratib olishga harakat qilamiz
                     const match = e.message.match(/\d+/);
                     const waitTime = match ? parseInt(match[0]) : 60;
                     bot.sendMessage(chatId, "Telegram cheklovi (FloodWait): " + waitTime + " sekund kuting...");
                     await new Promise(resolve => setTimeout(resolve, (waitTime + 2) * 1000));
                     i--;
                     continue;
                }

                if (e.message && e.message.includes('PEER_FLOOD')) {
                    bot.sendMessage(chatId, "Telegram cheklovi (Spam/Peer Flood). Reyd to'xtatildi.");
                    break;
                }
            }
            
            // Wait a bit to avoid instant ban (tezlik maksimal: 1ms)
            await new Promise(resolve => setTimeout(resolve, 1));
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

        bot.sendMessage(chatId, "🏁 **Reyd yakunlandi!**\n\n✅ **Yuborildi:** " + sent + "\n❌ **Xatolik:** " + errors, { 
            parse_mode: "Markdown",
            ...getMainMenu()
        });
        
        // Statistikani yangilash
        if (sent > 0) {
            await User.findOneAndUpdate({ chatId }, { $inc: { reydCount: 1 } });
        }

    } catch (e) {
        console.error("Reyd fatal error:", e);
        if (reydSessions[chatId]) delete reydSessions[chatId];
        bot.sendMessage(chatId, "Reyd xatolik bilan tugadi: " + e.message);
    }
}

async function startReklama(chatId, client, users, content, contentType, entities, startIndex = 0) {
    let sentCount = 0;
    let failCount = 0;
    
    // GramJS uchun entities konvertatsiya qilish (faqat text bo'lsa)
    let messageEntities = null;
    if (contentType === 'text' && entities && entities.length > 0) {
        try {
             messageEntities = entities.map(e => {
                 if (e.type === 'bold') return new Api.MessageEntityBold({ offset: e.offset, length: e.length });
                 if (e.type === 'italic') return new Api.MessageEntityItalic({ offset: e.offset, length: e.length });
                 if (e.type === 'code') return new Api.MessageEntityCode({ offset: e.offset, length: e.length });
                 if (e.type === 'pre') return new Api.MessageEntityPre({ offset: e.offset, length: e.length, language: e.language || '' });
                 if (e.type === 'text_link') return new Api.MessageEntityTextUrl({ offset: e.offset, length: e.length, url: e.url });
                 if (e.type === 'url') return new Api.MessageEntityUrl({ offset: e.offset, length: e.length });
                 if (e.type === 'custom_emoji') {
                     // Custom emoji ID string bo'lishi mumkin, lekin GramJS BigInt kutadi
                     return new Api.MessageEntityCustomEmoji({
                         offset: e.offset,
                         length: e.length,
                         documentId: BigInt(e.custom_emoji_id) 
                     });
                 }
                 return null;
             }).filter(e => e !== null);
        } catch (err) {
            console.error("Entity conversion error:", err);
        }
    }

    // Sessiyani tekshiramiz
    if (!reklamaSessions[chatId]) {
        // Agar sessiya bo'lmasa, yangi yaratamiz (agar bu yerga to'g'ridan-to'g'ri chaqirilsa)
        reklamaSessions[chatId] = {
            status: 'active',
            users: users,
            content: content,
            contentType: contentType,
            entities: entities,
            currentIndex: startIndex,
            errorState: false
        };
    }

    for (let i = startIndex; i < users.length; i++) {
        // Statusni tekshirish
        if (!reklamaSessions[chatId] || reklamaSessions[chatId].status === 'stopped') {
            break;
        }

        reklamaSessions[chatId].currentIndex = i;

        const username = users[i];
        try {
            if (contentType === 'sticker') {
                // Stikerni yuborish
                await client.sendMessage(username, { 
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
                // Matnni yuborish (entities bilan)
                await client.sendMessage(username, { 
                    message: content,
                    formattingEntities: messageEntities
                });
            }
            
            sentCount++;
            console.log("[" + chatId + "] Reklama yuborildi: " + username);
        } catch (err) {
            failCount++;
            console.error("[" + chatId + "] Reklama xatolik (" + username + "):", err);
            
            if (err.message && (err.message.includes('PEER_FLOOD') || err.message.includes('FLOOD_WAIT') || err.message.includes('spam'))) {
                reklamaSessions[chatId].status = 'paused';
                reklamaSessions[chatId].errorState = true;
                reklamaSessions[chatId].currentIndex = i; // Shu yerdan davom ettiramiz
                
                bot.sendMessage(chatId, "DIQQAT! Telegram sizni vaqtincha spam qildi.\nReklama vaqtincha to'xtatildi.\n\nDavom ettirish yoki tugatishni tanlang:", {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "▶️ Davom ettirish", callback_data: "rek_resume" }, { text: "⏹ Tugatish", callback_data: "rek_stop" }]
                        ]
                    }
                });
                return; // Funksiyadan chiqib ketamiz, sessiya saqlanib qoladi
            }
        }
        
        // 1 sekund kutish
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Agar loop tugasa va status 'active' bo'lsa (yoki stopped)
    if (reklamaSessions[chatId]) {
        delete reklamaSessions[chatId];
    }
    
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
    
    bot.sendMessage(chatId, "🏁 **Reklama yakunlandi!**\n\n📦 **Jami:** " + users.length + "\n✅ **Yuborildi:** " + sentCount + "\n❌ **O'xshamadi:** " + failCount, { parse_mode: "Markdown", ...getMainMenu() });
    
    // Statistikani yangilash
    if (sentCount > 0) {
        await User.findOneAndUpdate({ chatId }, { $inc: { adsCount: sentCount } });
    }
}

async function startUserbot(client, chatId) {
    console.log("Userbot " + chatId + " uchun ishga tushdi.");
    
    // Default holat: Yoqilgan
    if (avtoAlmazStates[chatId] === undefined) {
        avtoAlmazStates[chatId] = true;
    }

    client.addEventHandler(async (event) => {
        const message = event.message;

        // Agar funksiya o'chirilgan bo'lsa, ishlamaydi
        if (avtoAlmazStates[chatId] === false) return;
        
        // Faqat tugmasi bor xabarlarni tekshiramiz
        if (message && message.buttons && message.buttons.length > 0) {
            let clicked = false;
            
            const rows = message.buttons;
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                for (let j = 0; j < row.length; j++) {
                    const button = row[j];
                    
                    if (button.text) {
                        const btnText = button.text.trim().toLowerCase();
                        
                        // Qat'iy tekshirish (Strict check)
                        // Faqat "olish", "клик" yoki "bosing" so'zlari bo'lsa bosadi
                        if (btnText === 'olish' || btnText === 'клик' || btnText === 'bosing') {
                            console.log("[" + chatId + "] Tugma topildi (Strict): " + button.text);
                            try {
                                await message.click(i, j);
                                console.log("[" + chatId + "] Tugma bosildi!");
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

                                bot.sendMessage(chatId, "Avto Almaz: 1 almaz olindi\n" + chatTitle + "\n\nJami: " + totalClicks + " ta", { parse_mode: "Markdown" });
                                
                                break;
                            } catch (err) {
                                console.error("Tugmani bosishda xatolik:", err);
                            }
                        }
                    }
                }
                if (clicked) break;
            }
        }
    }, new NewMessage({}));
}

// Bot qayta ishga tushganda sessiyalarni tiklash
async function restoreUserSession(chatId, sessionString) {
    try {
        console.log("Sessiyani tiklash: " + chatId);
        const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
            connectionRetries: 5,
        });
        await client.connect();
        userClients[chatId] = client;
        startUserbot(client, chatId);
        console.log("Userbot " + chatId + " qayta tiklandi.");
    } catch (e) {
        console.error("Sessiyani tiklashda xatolik (" + chatId + "):", e);
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
    console.error("Polling xatosi: " + error.code + " - " + error.message);
});

// End of file
