require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const { Api } = require("telegram/tl");
const fs = require('fs');
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

// Botni yaratish
const bot = new TelegramBot(token, { polling: true });

// Foydalanuvchi holatlari
const userStates = {};
// Promise-larni saqlash uchun
const loginPromises = {};
// Userbot clients
const userClients = {};

// DB fayli
const DB_FILE = 'users.json';

// DB funksiyalari
function getUsers() {
    try {
        if (!fs.existsSync(DB_FILE)) {
            fs.writeFileSync(DB_FILE, '[]');
            return [];
        }
        const data = fs.readFileSync(DB_FILE, 'utf8');
        return JSON.parse(data);
    } catch (e) {
        console.error("DB o'qishda xatolik:", e);
        return [];
    }
}

function saveUsers(users) {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(users, null, 2));
    } catch (e) {
        console.error("DB yozishda xatolik:", e);
    }
}

function getUser(chatId) {
    const users = getUsers();
    return users.find(u => u.chatId === chatId);
}

function updateUser(chatId, data) {
    let users = getUsers();
    const index = users.findIndex(u => u.chatId === chatId);
    if (index !== -1) {
        users[index] = { ...users[index], ...data };
        saveUsers(users);
        return users[index];
    } else {
        const newUser = { chatId, status: 'pending', clicks: 0, joinedAt: new Date().toISOString(), ...data };
        users.push(newUser);
        saveUsers(users);
        return newUser;
    }
}

function updateStats(chatId) {
    let users = getUsers();
    const index = users.findIndex(u => u.chatId === chatId);
    if (index !== -1) {
        users[index].clicks = (users[index].clicks || 0) + 1;
        saveUsers(users);
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
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const name = msg.from.first_name;
    
    console.log(`User started: ${name} (${chatId})`);

    let user = getUser(chatId);
    
    // Agar foydalanuvchi Admin bo'lsa, uni avtomatik 'approved' qilamiz
    if (chatId === ADMIN_ID) {
        if (!user) {
            user = updateUser(chatId, { name, status: 'approved' });
            bot.sendMessage(chatId, "👋 Salom Admin! Tizimga xush kelibsiz.");
        } else if (user.status !== 'approved') {
            user = updateUser(chatId, { status: 'approved' });
            bot.sendMessage(chatId, "👋 Salom Admin! Maqomingiz tiklandi.");
        }
    }

    if (!user) {
        // Yangi oddiy foydalanuvchi
        user = updateUser(chatId, { name, status: 'pending' });
        
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
                         ["💎 Avto Almaz", "👥 AvtoYuser"],
                         ["👨‍💼 Avto Admin Id", "📣 Avto Reklama"],
                         ["📊 Profil", "🔄 Nomer almashtirish"],
                         ["ℹ️ Yordam"]
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
bot.onText(/\/approve (\d+)/, (msg, match) => {
    const chatId = msg.chat.id;
    if (chatId !== ADMIN_ID) return;

    const targetId = parseInt(match[1]);
    const user = getUser(targetId);

    if (user) {
        updateUser(targetId, { status: 'approved' });
        bot.sendMessage(chatId, `✅ Foydalanuvchi ${targetId} tasdiqlandi.`);
        bot.sendMessage(targetId, "🎉 Siz admin tomonidan tasdiqlandingiz!\nEndi **/start** ni bosib ro'yxatdan o'tishingiz mumkin.", { parse_mode: "Markdown" });
    } else {
        bot.sendMessage(chatId, "❌ Foydalanuvchi topilmadi. U avval botga /start bosishi kerak.");
    }
});

bot.onText(/\/block (\d+)/, (msg, match) => {
    const chatId = msg.chat.id;
    if (chatId !== ADMIN_ID) return;

    const targetId = parseInt(match[1]);
    const user = getUser(targetId);

    if (user) {
        updateUser(targetId, { status: 'blocked', session: null }); // Sessiyani o'chiramiz
        
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

bot.onText(/\/stats/, (msg) => {
    const chatId = msg.chat.id;
    if (chatId !== ADMIN_ID) return;

    const users = getUsers();
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

bot.onText(/\/profile/, (msg) => {
    const chatId = msg.chat.id;
    const user = getUser(chatId);

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
bot.onText(/\/menu/, (msg) => {
    const chatId = msg.chat.id;
    const user = getUser(chatId);

    if (user && user.session && user.status === 'approved') {
        const mainMenu = {
            reply_markup: {
                keyboard: [
                    ["💎 Avto Almaz", "👥 AvtoYuser"],
                    ["👨‍💼 Avto Admin Id", "📣 Avto Reklama"],
                    ["📊 Profil", "🔄 Nomer almashtirish"],
                    ["ℹ️ Yordam"]
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
bot.onText(/\/rek/, (msg) => {
    const chatId = msg.chat.id;
    const user = getUser(chatId);

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
        const user = getUser(chatId);
        if (user && user.session) {
             const clicks = user.clicks || 0;
             bot.sendMessage(chatId, `💎 **Avto Almaz**\n\n✅ **Holat:** Faol\n💎 **Jami to'plangan:** ${clicks} ta\n\nBot avtomatik ravishda guruhlardagi 💎 tugmalarini bosib almaz yig'moqda.`, { parse_mode: "Markdown" });
        } else {
             bot.sendMessage(chatId, "❌ Bu bo'limga kirish uchun avval tizimga kiring (/start).");
        }
        return;
    }

    if (text === "👥 AvtoYuser") {
        bot.sendMessage(chatId, "🛠 **AvtoYuser**\n\nBu funksiya tez kunda ishga tushadi! 🚀\nU orqali siz guruhlardan foydalanuvchilarni yig'ib olishingiz mumkin bo'ladi.");
        return;
    }

    if (text === "👨‍💼 Avto Admin Id") {
        if (ADMIN_ID) {
            bot.sendMessage(chatId, `👨‍💼 **Admin ID:** \`${ADMIN_ID}\`\n\nSavollar va takliflar uchun admin bilan bog'laning.`, { parse_mode: "Markdown" });
        } else {
            bot.sendMessage(chatId, "⚠️ Admin ID sozlanmagan.");
        }
        return;
    }

    if (text === "📣 Avto Reklama") {
        // /rek funksiyasini chaqiramiz (msg obyektini simulyatsiya qilamiz yoki shunchaki logikani takrorlaymiz)
        // Lekin eng osoni - mavjud /rek listenerini ishlatish emas, balki logikani shu yerda chaqirish.
        // Yoki shunchaki userStates ga yozib yuborish.
        
        const user = getUser(chatId);
        if (!user || user.status !== 'approved' || !userClients[chatId]) {
            bot.sendMessage(chatId, "❌ Bu funksiyadan foydalanish uchun avval ro'yxatdan o'ting va hisobingizga kiring.");
            return;
        }
    
        userStates[chatId] = { step: 'WAITING_REK_USERS' };
        bot.sendMessage(chatId, "🚀 **Avto Reklama**\n\nIltimos, reklama yuboriladigan foydalanuvchilar username-larini yuboring.\n\n_Misol:_\n@user1\n@user2\n@user3\n\n(Maksimum 100 ta username)", { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } }); // Keyboardni vaqtincha olib tashlaymiz
        return;
    }

    if (text === "📊 Profil") {
        const user = getUser(chatId);
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
        const user = getUser(chatId);
        if (user) {
            // Sessiyani o'chirish
            updateUser(chatId, { session: null });
            
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

    if (text === "ℹ️ Yordam") {
        bot.sendMessage(chatId, "ℹ️ **Yordam**\n\nBu bot orqali siz Telegram guruhlarida avtomatik ravishda almaz yig'ishingiz va reklama tarqatishingiz mumkin.\n\nMuammolar bo'lsa admin bilan bog'laning.");
        return;
    }

    if (text.startsWith('/')) return;

    let state = userStates[chatId];
    if (!state) return;

    // Faqat tasdiqlangan userlar login qila oladi
    const user = getUser(chatId);
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
            }).then(() => {
                console.log(`[${chatId}] Client connected successfully!`);
                const session = client.session.save();
                
                // Bazaga sessiyani saqlash
                updateUser(chatId, { session: session });
                
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
                    updateStats(chatId);
                    const user = getUser(chatId);
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
        updateUser(chatId, { session: null }); // Sessiyani o'chirish
    }
}

// Bot ishga tushganda barcha saqlangan sessiyalarni yuklash
(async () => {
    const users = getUsers();
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
