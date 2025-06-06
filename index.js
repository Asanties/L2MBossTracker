// Import necessary classes from discord.js
const { Client, GatewayIntentBits, Collection, Partials, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField } = require('discord.js');
const fs = require('fs'); // File System module for saving/loading data
const path = require('path'); // Path module for constructing file paths

// If using dotenv for token storage
require('dotenv').config();

// Get the bot token from environment variables or directly (if not using dotenv)
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

if (!BOT_TOKEN) {
    console.error("Error: Bot token not found. Make sure you have created a .env file with DISCORD_BOT_TOKEN or specified the token directly in the code.");
    process.exit(1); // Exit the application if the token is not found
}

// Define the Intents (permissions) needed by the bot
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

client.commands = new Collection();
// Structure of client.bossData:
// Collection<guildId, Collection<bossKey, bossObject>>
// bossObject: { name, location, minRespawnHours, maxRespawnHours, lastKilled, nextSpawnEstimateMin, nextSpawnEstimateMax, isWindow, notificationJob(runtime), spawnNotificationJob(runtime), autoMissJob(runtime), messageIdToTrack, notificationChannelId, originalChannelId }
client.bossData = new Collection();


const prefix = '!';
const DATA_FILE_PATH = path.join(__dirname, 'boss_data.json'); // Path to the data file

// Timers for notifications
// { guildId_bossKey_type: timeoutObject }
client.activeTimers = new Map();

const AUTO_MISS_TIMEOUT_MINUTES = 20;


client.on('ready', () => {
    console.log(`Bot ${client.user.tag} successfully launched and ready!`);
    console.log(`Bot ID: ${client.user.id}`);
    console.log('------');
    client.user.setActivity(`Lineage 2M | ${prefix}help`, { type: 3 /* WATCHING */ });

    loadBossData();
    initializeBossTimers(); // Must be after loading data
});

function saveBossData() {
    const dataToSave = {};
    client.bossData.forEach((guildBosses, guildId) => {
        dataToSave[guildId] = {};
        guildBosses.forEach((bossObject, bossKey) => {
            // Create a copy to avoid modifying the live object directly for saving
            const bossToSave = { ...bossObject };
            // Remove runtime timer IDs before saving, they will be recreated
            delete bossToSave.notificationJob;
            delete bossToSave.spawnNotificationJob;
            delete bossToSave.autoMissJob;
            dataToSave[guildId][bossKey] = bossToSave;
        });
    });

    try {
        fs.writeFileSync(DATA_FILE_PATH, JSON.stringify(dataToSave, null, 4));
        console.log('Boss data saved successfully.');
    } catch (error) {
        console.error('Failed to save boss data:', error);
    }
}

function loadBossData() {
    try {
        if (fs.existsSync(DATA_FILE_PATH)) {
            const rawData = fs.readFileSync(DATA_FILE_PATH);
            const loadedData = JSON.parse(rawData);
            
            client.bossData.clear(); // Clear any existing in-memory data before loading

            for (const guildId in loadedData) {
                const guildBossesCollection = new Collection();
                for (const bossKey in loadedData[guildId]) {
                    // Ensure runtime timer job properties are null initially after loading
                    const bossObject = loadedData[guildId][bossKey];
                    bossObject.notificationJob = null;
                    bossObject.spawnNotificationJob = null;
                    bossObject.autoMissJob = null;
                    guildBossesCollection.set(bossKey, bossObject);
                }
                client.bossData.set(guildId, guildBossesCollection);
            }
            console.log('Boss data loaded successfully.');
        } else {
            console.log('No existing boss data file found. Starting fresh.');
        }
    } catch (error) {
        console.error('Failed to load boss data:', error);
        // If loading fails, start with an empty collection to prevent crashes
        client.bossData = new Collection();
    }
}

function initializeBossTimers() {
    console.log('Initializing timers for loaded bosses...');
    const now = Date.now();
    client.bossData.forEach((guildBosses, guildId) => {
        guildBosses.forEach((boss, bossKey) => {
            // Only schedule if there's a future spawn time
            if (boss.nextSpawnEstimateMin && boss.nextSpawnEstimateMin > now) {
                console.log(`Re-scheduling notifications for ${boss.name} (${bossKey}) in guild ${guildId}`);
                scheduleBossNotifications(guildId, bossKey);
            }
            // Check if an auto-miss timer needs to be re-established for a message with buttons
            if (boss.messageIdToTrack && boss.spawnNotificationJob === null && boss.autoMissJob === null) {
                 console.log(`Found active message with buttons for ${boss.name} (${bossKey}). Re-scheduling auto-miss timer.`);
                 // Ensure the notificationChannelId or originalChannelId is valid before scheduling
                 const channelForAutoMiss = boss.notificationChannelId || boss.originalChannelId;
                 if (channelForAutoMiss) {
                    scheduleAutoMissTimer(guildId, bossKey, boss.messageIdToTrack, channelForAutoMiss);
                 } else {
                    console.warn(`Cannot re-schedule auto-miss for ${boss.name} (${bossKey}): no valid channel ID found.`);
                 }
            }
        });
    });
    console.log('Boss timer initialization complete.');
}


client.on('messageCreate', async message => {
    if (message.author.bot || !message.content.startsWith(prefix)) return;

    const args = parseArguments(message.content.slice(prefix.length).trim());
    const commandName = args.shift().toLowerCase();

    if (commandName === 'ping') {
        const latency = Math.round(client.ws.ping);
        await message.reply(`Pong! API Latency: ${latency}ms.`);
        return;
    }

    if (commandName === 'help') {
        const helpEmbed = new EmbedBuilder()
            .setColor(0x0099FF)
            .setTitle('📜 Bot Commands Help')
            .setDescription('Click a button to learn more about the command.');

        const row1 = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder().setCustomId('help_addboss').setLabel('Add Boss').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('help_killed').setLabel('Mark Killed').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('help_status').setLabel('Status').setStyle(ButtonStyle.Secondary)
            );
        const row2 = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder().setCustomId('help_removeboss').setLabel('Remove Boss').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId('help_setchannel').setLabel('Notification Channel').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('help_ping').setLabel('Ping').setStyle(ButtonStyle.Secondary)
            );

        await message.channel.send({ embeds: [helpEmbed], components: [row1, row2] });
        return;
    }

    const guildId = message.guild.id;
    if (!client.bossData.has(guildId)) {
        client.bossData.set(guildId, new Collection());
    }
    const guildBosses = client.bossData.get(guildId);

    if (commandName === 'addboss') {
        if (args.length < 3) {
            return message.reply(`Usage: ${prefix}addboss "<name>" "<location>" <min_respawn_hours> [max_respawn_hours] [notification_channel_id]`);
        }
        const bossName = args[0];
        const bossKey = bossName.toLowerCase().replace(/\s+/g, '_');
        const location = args[1];
        const minRespawnHours = parseFloat(args[2]);
        const maxRespawnHours = args[3] && !isNaN(parseFloat(args[3])) ? parseFloat(args[3]) : null;
        const notificationChannelIdArg = args[3] && isNaN(parseFloat(args[3])) ? args[3] : (args[4] ? args[4] : null);
        
        let notificationChannelId = notificationChannelIdArg || message.channel.id;

        if (guildBosses.has(bossKey)) {
            return message.reply(`Boss with name "${bossName}" already exists.`);
        }
        if (isNaN(minRespawnHours) || (maxRespawnHours !== null && isNaN(maxRespawnHours))) {
            return message.reply('Respawn time must be a number.');
        }
        if (maxRespawnHours !== null && maxRespawnHours < minRespawnHours) {
            return message.reply('Maximum respawn time cannot be less than minimum.');
        }
        
        try {
            const channel = await client.channels.fetch(notificationChannelId);
            if (!channel || channel.type !== 0 /* GUILD_TEXT */) {
                 message.reply(`Warning: Channel with ID ${notificationChannelId} not found or is not a text channel. Notifications for this boss will be sent to the current channel (<#${message.channel.id}>).`);
                 notificationChannelId = message.channel.id;
            }
        } catch (error) {
             message.reply(`Warning: Error checking channel ${notificationChannelId}. Notifications for this boss will be sent to the current channel (<#${message.channel.id}>).`);
             notificationChannelId = message.channel.id;
        }

        guildBosses.set(bossKey, {
            name: bossName,
            location: location,
            minRespawnHours: minRespawnHours,
            maxRespawnHours: maxRespawnHours,
            lastKilled: null,
            nextSpawnEstimateMin: null,
            nextSpawnEstimateMax: null,
            isWindow: false,
            notificationJob: null,
            spawnNotificationJob: null,
            autoMissJob: null,
            messageIdToTrack: null,
            notificationChannelId: notificationChannelId,
            originalChannelId: message.channel.id
        });
        client.bossData.set(guildId, guildBosses);
        await message.reply(`Boss **${bossName}** (Location: ${location}, Respawn: ${minRespawnHours}${maxRespawnHours ? `-${maxRespawnHours}` : ''} hrs) added. Notifications in channel <#${notificationChannelId}>.`);
        saveBossData();
    } else if (commandName === 'killed') {
        if (args.length < 1) {
            return message.reply(`Usage: ${prefix}killed "<boss_name>" [time: YYYY-MM-DD HH:MM / MM/DD/YYYY HH:MM / timestamp_seconds]`);
        }
        const bossNameArg = args[0];
        const bossKey = bossNameArg.toLowerCase().replace(/\s+/g, '_');
        const boss = guildBosses.get(bossKey);

        if (!boss) {
            return message.reply(`Boss "${bossNameArg}" not found.`);
        }

        let killTimestamp = new Date().getTime(); 

        if (args.length > 1) {
            const timeInputString = args.slice(1).join(" "); 
            let parsedDate;

            if (/^\d+$/.test(timeInputString)) {
                const numTime = parseInt(timeInputString, 10);
                if (timeInputString.length <= 10) { 
                    parsedDate = new Date(numTime * 1000);
                } else { 
                    parsedDate = new Date(numTime);
                }
            } else {
                parsedDate = new Date(timeInputString);
            }

            if (isNaN(parsedDate.getTime())) {
                return message.reply(`Invalid time format: "${timeInputString}". Please use a format like "YYYY-MM-DD HH:MM:SS", "MM/DD/YYYY HH:MM", or a Unix timestamp (seconds or milliseconds).`);
            }
            
            if (parsedDate.getTime() > new Date().getTime() + 60000) { 
                 return message.reply(`Future kill times are not allowed. The time provided (${parsedDate.toLocaleString()}) is in the future.`);
            }
            killTimestamp = parsedDate.getTime();
        }

        updateBossAsKilled(guildId, bossKey, killTimestamp, message.channel, null);
        saveBossData();
    } else if (commandName === 'status') {
        if (guildBosses.size === 0) {
            return message.reply('No bosses are being tracked on this server.');
        }

        const embeds = [];
        if (args.length > 0) {
            const bossNameArg = args.join(" "); 
            const bossKey = bossNameArg.toLowerCase().replace(/\s+/g, '_');
            const boss = guildBosses.get(bossKey);
            if (boss) {
                embeds.push(createBossStatusEmbed(boss));
            } else {
                return message.reply(`Boss "${bossNameArg}" not found.`);
            }
        } else {
            guildBosses.forEach(boss => {
                embeds.push(createBossStatusEmbed(boss));
            });
        }
        
        if (embeds.length > 0) {
             for (let i = 0; i < embeds.length; i += 10) {
                const chunk = embeds.slice(i, i + 10);
                await message.channel.send({ embeds: chunk });
            }
        } else {
             return message.reply('No information to display.');
        }

    } else if (commandName === 'removeboss') {
        if (args.length < 1) {
            return message.reply(`Usage: ${prefix}removeboss "<boss_name>"`);
        }
        const bossNameArg = args[0];
        const bossKey = bossNameArg.toLowerCase().replace(/\s+/g, '_');

        if (guildBosses.has(bossKey)) {
            clearBossTimers(guildId, bossKey);
            guildBosses.delete(bossKey);
            client.bossData.set(guildId, guildBosses); 
            await message.reply(`Boss "${bossNameArg}" removed.`);
            saveBossData();
        } else {
            await message.reply(`Boss "${bossNameArg}" not found.`);
        }
    } else if (commandName === 'setchannel') {
        if (args.length < 2) {
            return message.reply(`Usage: ${prefix}setchannel "<boss_name>" <channel_id>`);
        }
        const bossNameArg = args[0];
        const bossKey = bossNameArg.toLowerCase().replace(/\s+/g, '_');
        const newChannelId = args[1];
        const boss = guildBosses.get(bossKey);

        if (!boss) {
            return message.reply(`Boss "${bossNameArg}" not found.`);
        }

        try {
            const channel = await client.channels.fetch(newChannelId);
            if (channel && channel.type === 0 /* GUILD_TEXT */) {
                const botMember = await message.guild.members.fetch(client.user.id);
                if (!channel.permissionsFor(botMember).has(PermissionsBitField.Flags.SendMessages)) {
                     return message.reply(`I do not have permission to send messages in channel <#${newChannelId}>.`);
                }

                boss.notificationChannelId = newChannelId;
                await message.reply(`Notification channel for boss **${boss.name}** changed to <#${newChannelId}>.`);
                saveBossData();
                if (boss.nextSpawnEstimateMin && boss.nextSpawnEstimateMin > Date.now()) {
                    scheduleBossNotifications(guildId, bossKey); 
                }
            } else {
                await message.reply(`Channel with ID ${newChannelId} not found or is not a text channel.`);
            }
        } catch (error) {
            console.error("Error setting channel:", error);
            await message.reply(`Could not find channel with ID ${newChannelId}.`);
        }
    }
});

function parseArguments(content) {
    const regex = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
    const results = [];
    let match;
    while (match = regex.exec(content)) {
        results.push(match[1] || match[2] || match[0]);
    }
    return results;
}

function createBossStatusEmbed(boss) {
    const embed = new EmbedBuilder()
        .setColor(boss.lastKilled ? (boss.isWindow ? 0xFFD700 : 0x00FF00) : 0xFF0000)
        .setTitle(`👑 ${boss.name} - ${boss.location}`)
        .addFields(
            { name: 'Respawn', value: `${boss.minRespawnHours}${boss.maxRespawnHours ? `-${boss.maxRespawnHours}` : ''} hrs` },
            { name: 'Notification Channel', value: `<#${boss.notificationChannelId || boss.originalChannelId}>` }
        );

    if (boss.lastKilled) {
        embed.addFields({ name: 'Last Killed', value: `<t:${Math.floor(boss.lastKilled / 1000)}:F>` });
    }
    if (boss.nextSpawnEstimateMin) {
        embed.addFields({ name: 'Next Respawn', value: formatNextSpawn(boss) });
    } else {
        embed.addFields({ name: 'Next Respawn', value: 'No information (mark kill with `!killed` command)' });
    }
    if (boss.isWindow) {
        embed.setFooter({ text: 'ATTENTION: Respawn time is a window (not exact)!' });
    }
    return embed;
}

function updateBossAsKilled(guildId, bossKey, killTimestamp, replyChannel, interaction = null) {
    const guildBosses = client.bossData.get(guildId);
    if (!guildBosses) return;
    const boss = guildBosses.get(bossKey);
    if (!boss) return;

    boss.lastKilled = killTimestamp; 
    boss.isWindow = false;

    boss.nextSpawnEstimateMin = killTimestamp + boss.minRespawnHours * 60 * 60 * 1000;
    if (boss.maxRespawnHours && boss.maxRespawnHours > boss.minRespawnHours) {
        boss.nextSpawnEstimateMax = killTimestamp + boss.maxRespawnHours * 60 * 60 * 1000;
    } else {
        boss.nextSpawnEstimateMax = null; 
    }
    
    const replyContent = `💀 Boss **${boss.name}** (${boss.location}) marked as killed at <t:${Math.floor(killTimestamp / 1000)}:F>! Next respawn: ${formatNextSpawn(boss)}`;
    
    if (interaction) {
        interaction.reply({ content: replyContent, ephemeral: false });
    } else if (replyChannel) {
        replyChannel.send(replyContent);
    }
    
    clearBossTimers(guildId, bossKey); 
    scheduleBossNotifications(guildId, bossKey);
    saveBossData(); 
}


client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;

    // Help button interactions
    if (interaction.customId.startsWith('help_')) {
        const helpCommand = interaction.customId.split('_')[1];
        let helpText = 'Command Information:\n';
        let ephemeral = true;

        switch (helpCommand) {
            case 'addboss':
                helpText += `**${prefix}addboss "<name>" "<location>" <min_hr> [max_hr] [channel_id]**\n`;
                helpText += 'Adds a new boss to track.\n';
                helpText += '- `<name>`: Boss name (in quotes if it has spaces).\n';
                helpText += '- `<location>`: Boss location (in quotes if it has spaces).\n';
                helpText += '- `<min_hr>`: Minimum respawn time in hours (e.g., `4`).\n';
                helpText += '- `[max_hr]`: Optional. Maximum respawn time in hours if it\'s a window (e.g., `6`). If omitted, respawn is considered fixed.\n';
                helpText += '- `[channel_id]`: Optional. Channel ID for notifications. If omitted, the current channel is used.\n';
                helpText += 'Example: `!addboss "Queen Ant" "Ant Nest" 22 26`';
                break;
            case 'killed':
                helpText += `**${prefix}killed "<name>" [time]**\n`;
                helpText += 'Marks a boss as killed.\n';
                helpText += '- `<name>`: Boss name (in quotes if it has spaces).\n';
                helpText += '- `[time]`: Optional. Time of kill. If omitted, current time is used. Formats: "YYYY-MM-DD HH:MM", "MM/DD/YYYY HH:MM", Unix timestamp (seconds or ms).\n';
                helpText += 'Example: `!killed "Orfen" "2024-07-15 22:10"` or `!killed "Baium"`';
                break;
            case 'status':
                helpText += `**${prefix}status [name]**\n`;
                helpText += 'Shows the status of all tracked bosses or a specific boss.\n';
                helpText += '- `[name]`: Optional. Boss name. If omitted, shows status for all bosses.';
                break;
            case 'removeboss':
                helpText += `**${prefix}removeboss "<name>"**\n`;
                helpText += 'Removes a boss from the tracking list.\n';
                helpText += '- `<name>`: Boss name (in quotes if it has spaces).';
                break;
            case 'setchannel':
                helpText += `**${prefix}setchannel "<name>" <channel_id>**\n`;
                helpText += 'Sets or changes the notification channel for a specific boss.\n';
                helpText += '- `<name>`: Boss name (in quotes if it has spaces).\n';
                helpText += '- `<channel_id>`: ID of the text channel for notifications.';
                break;
            case 'ping':
                helpText += `**${prefix}ping**\n`;
                helpText += 'Checks the bot\'s response latency.';
                break;
            default:
                helpText = 'Unknown help command.';
        }
        await interaction.reply({ content: helpText, ephemeral: ephemeral });
        return;
    }


    // Boss action button interactions
    const [action, bossKeyFromId, guildIdFromId] = interaction.customId.split('_'); 
    
    if (guildIdFromId !== interaction.guildId) {
        console.warn(`Mismatch guildId in customId: ${guildIdFromId} vs interaction.guildId: ${interaction.guildId}`);
        return interaction.reply({ content: 'Server identification error.', ephemeral: true });
    }

    const guildBosses = client.bossData.get(interaction.guildId);
    if (!guildBosses) {
        return interaction.reply({ content: 'Boss data for this server not found.', ephemeral: true });
    }
    const boss = guildBosses.get(bossKeyFromId);

    if (!boss) {
        await interaction.message.edit({ content: `Information for boss ${bossKeyFromId} not found. It might have been removed.`, components: [] }).catch(console.error);
        return interaction.reply({ content: `Information for boss ${bossKeyFromId} not found.`, ephemeral: true });
    }

    const autoMissTimerKey = `${interaction.guildId}_${bossKeyFromId}_automiss`;
    const autoMissTimer = client.activeTimers.get(autoMissTimerKey);
    if (autoMissTimer) {
        clearTimeout(autoMissTimer);
        client.activeTimers.delete(autoMissTimerKey);
        boss.autoMissJob = null; 
    }
    
    if (interaction.message && interaction.message.components.length > 0) {
       await interaction.message.edit({ components: [] }).catch(console.error);
    }

    const now = new Date().getTime();

    if (action === 'dead') {
        updateBossAsKilled(interaction.guildId, bossKeyFromId, now, interaction.channel, interaction);
    } else if (action === 'miss') {
        boss.isWindow = true;
        boss.lastKilled = null; 
        boss.nextSpawnEstimateMin = now + boss.minRespawnHours * 60 * 60 * 1000;
        if (boss.maxRespawnHours && boss.maxRespawnHours > boss.minRespawnHours) {
            boss.nextSpawnEstimateMax = now + boss.maxRespawnHours * 60 * 60 * 1000;
        } else { 
            boss.nextSpawnEstimateMax = now + (boss.minRespawnHours + 1) * 60 * 60 * 1000;
        }
        boss.isWindow = true; 

        await interaction.reply({ content: `🤷 Boss **${boss.name}** (${boss.location}) was **missed**. Next *possible* appearance time (window): ${formatNextSpawn(boss)}. **This is not an exact time!**`, ephemeral: false });
        clearBossTimers(interaction.guildId, bossKeyFromId); 
        scheduleBossNotifications(interaction.guildId, bossKeyFromId);
        saveBossData();

    } else if (action === 'notappeared') {
        boss.isWindow = true;
        let baseTime = boss.nextSpawnEstimateMin || now;

        boss.lastKilled = null;
        boss.nextSpawnEstimateMin = baseTime + 1 * 60 * 60 * 1000; 
        if (boss.nextSpawnEstimateMax) {
             boss.nextSpawnEstimateMax = boss.nextSpawnEstimateMax + 1 * 60 * 60 * 1000;
        } else if (boss.maxRespawnHours){ 
            boss.nextSpawnEstimateMax = boss.nextSpawnEstimateMin + (boss.maxRespawnHours - boss.minRespawnHours) * 60 * 60 * 1000;
             if (boss.nextSpawnEstimateMax <= boss.nextSpawnEstimateMin) { 
                boss.nextSpawnEstimateMax = boss.nextSpawnEstimateMin + 1 * 60 * 60 * 1000; 
            }
        } else { 
            boss.nextSpawnEstimateMax = boss.nextSpawnEstimateMin + 1 * 60 * 60 * 1000; 
        }
        boss.isWindow = true; 

        await interaction.reply({ content: `🚫 Boss **${boss.name}** (${boss.location}) **did not appear**. Expectation shifted. Next *possible* time (window): ${formatNextSpawn(boss)}. **This is not an exact time!**`, ephemeral: false });
        clearBossTimers(interaction.guildId, bossKeyFromId); 
        scheduleBossNotifications(interaction.guildId, bossKeyFromId);
        saveBossData();
    }
    boss.messageIdToTrack = null; 
});


function formatNextSpawn(boss) {
    if (!boss.nextSpawnEstimateMin) return "unknown";

    const minDate = new Date(boss.nextSpawnEstimateMin);
    let spawnTime = `<t:${Math.floor(minDate.getTime() / 1000)}:F> (<t:${Math.floor(minDate.getTime() / 1000)}:R>)`;

    if (boss.nextSpawnEstimateMax) {
        const maxDate = new Date(boss.nextSpawnEstimateMax);
        spawnTime += `\nto <t:${Math.floor(maxDate.getTime() / 1000)}:F> (<t:${Math.floor(maxDate.getTime() / 1000)}:R>)`;
    }
    if (boss.isWindow) {
        spawnTime += " **(Window)**";
    }
    return spawnTime;
}

const PRE_SPAWN_NOTIFICATION_MINUTES = 15; 

function scheduleBossNotifications(guildId, bossKey) {
    const guildBosses = client.bossData.get(guildId);
    if (!guildBosses) return;
    const boss = guildBosses.get(bossKey); 
    if (!boss || !boss.nextSpawnEstimateMin) return;

    const now = new Date().getTime();
    const preSpawnTime = boss.nextSpawnEstimateMin - PRE_SPAWN_NOTIFICATION_MINUTES * 60 * 1000;
    const spawnTime = boss.nextSpawnEstimateMin;

    clearBossTimers(guildId, bossKey); 

    if (preSpawnTime > now) {
        const delay = preSpawnTime - now;
        const timerKey = `${guildId}_${bossKey}_pre`;
        
        const timer = setTimeout(async () => {
            try {
                const currentBossData = client.bossData.get(guildId)?.get(bossKey); 
                if (!currentBossData || currentBossData.notificationJob !== timerKey) return; 

                const notifyChannel = await client.channels.fetch(currentBossData.notificationChannelId || currentBossData.originalChannelId).catch(() => null);
                if (notifyChannel) {
                    let messageContent = `🔔 **ATTENTION!** Boss **${currentBossData.name}** (${currentBossData.location}) is spawning soon!`;
                    if (currentBossData.isWindow) {
                         messageContent += `\nExpected window start: ${formatNextSpawn(currentBossData)}. **This is not an exact time!**`;
                    } else {
                         messageContent += `\nExpected time: ${formatNextSpawn(currentBossData)}.`;
                    }
                    await notifyChannel.send(messageContent);
                } else {
                    console.warn(`Pre-spawn: Could not find channel for boss ${currentBossData.name} (${currentBossData.notificationChannelId || currentBossData.originalChannelId})`);
                }
            } catch (e) { console.error("Error sending pre-spawn notification:", e); }
            client.activeTimers.delete(timerKey);
            const bossRef = client.bossData.get(guildId)?.get(bossKey); 
            if (bossRef) bossRef.notificationJob = null;
        }, delay);
        client.activeTimers.set(timerKey, timer);
        boss.notificationJob = timerKey; 
    }

    if (spawnTime > now) {
        const delay = spawnTime - now;
        const timerKey = `${guildId}_${bossKey}_spawn`;
        
        const timer = setTimeout(async () => {
            try {
                const currentBossData = client.bossData.get(guildId)?.get(bossKey); 
                if (!currentBossData || currentBossData.spawnNotificationJob !== timerKey) return; 

                const notifyChannel = await client.channels.fetch(currentBossData.notificationChannelId || currentBossData.originalChannelId).catch(() => null);
                if (notifyChannel) {
                    const row = new ActionRowBuilder()
                        .addComponents(
                            new ButtonBuilder()
                                .setCustomId(`dead_${bossKey}_${guildId}`)
                                .setLabel('✅ Killed (Dead)')
                                .setStyle(ButtonStyle.Success),
                            new ButtonBuilder()
                                .setCustomId(`miss_${bossKey}_${guildId}`)
                                .setLabel('🤷 Missed')
                                .setStyle(ButtonStyle.Secondary),
                            new ButtonBuilder()
                                .setCustomId(`notappeared_${bossKey}_${guildId}`)
                                .setLabel('🚫 Did Not Appear')
                                .setStyle(ButtonStyle.Danger),
                        );
                    
                    let spawnMessageContent = `🔥 Boss **${currentBossData.name}** (${currentBossData.location}) should be spawning **NOW**!`;
                     if (currentBossData.isWindow) {
                        spawnMessageContent = `⏳ The window for boss **${currentBossData.name}** (${currentBossData.location}) has started!`;
                        if(currentBossData.nextSpawnEstimateMax) {
                            spawnMessageContent += ` Window until <t:${Math.floor(new Date(currentBossData.nextSpawnEstimateMax).getTime() / 1000)}:R>.`;
                        }
                    }

                    const sentMessage = await notifyChannel.send({
                        content: spawnMessageContent,
                        components: [row]
                    });
                    
                    const bossRef = client.bossData.get(guildId)?.get(bossKey);
                    if (bossRef) { 
                        bossRef.messageIdToTrack = sentMessage.id;
                        scheduleAutoMissTimer(guildId, bossKey, sentMessage.id, notifyChannel.id);
                    }
                } else {
                     console.warn(`Spawn: Could not find channel for boss ${currentBossData.name} (${currentBossData.notificationChannelId || currentBossData.originalChannelId})`);
                }
            } catch (e) { console.error("Error sending spawn notification:", e); }
            client.activeTimers.delete(timerKey);
            const bossRef = client.bossData.get(guildId)?.get(bossKey);
            if (bossRef) bossRef.spawnNotificationJob = null;
        }, delay);
        client.activeTimers.set(timerKey, timer);
        boss.spawnNotificationJob = timerKey; 
    }
}

function scheduleAutoMissTimer(guildId, bossKey, originalMessageId, channelIdForAutoMissMessage) {
    const autoMissDelay = AUTO_MISS_TIMEOUT_MINUTES * 60 * 1000;
    const timerKey = `${guildId}_${bossKey}_automiss`;

    const existingTimer = client.activeTimers.get(timerKey);
    if (existingTimer) {
        clearTimeout(existingTimer);
        client.activeTimers.delete(timerKey);
    }
    
    const bossDataRef = client.bossData.get(guildId)?.get(bossKey);
    if (!bossDataRef) {
        console.warn(`AutoMiss: Boss ${bossKey} not found in guild ${guildId} when scheduling.`);
        return; 
    }

    const timer = setTimeout(async () => {
        try {
            const currentBossData = client.bossData.get(guildId)?.get(bossKey); 
            if (!currentBossData || currentBossData.autoMissJob !== timerKey || currentBossData.messageIdToTrack !== originalMessageId) {
                client.activeTimers.delete(timerKey); 
                return;
            }

            console.log(`Auto-missing boss ${currentBossData.name} (${bossKey}) for guild ${guildId}`);

            try {
                const notifyChannel = await client.channels.fetch(currentBossData.notificationChannelId || currentBossData.originalChannelId).catch(() => null);
                if (notifyChannel && currentBossData.messageIdToTrack) { 
                    const trackedMessage = await notifyChannel.messages.fetch(currentBossData.messageIdToTrack).catch(() => null);
                    if (trackedMessage && trackedMessage.components.length > 0) {
                        await trackedMessage.edit({ components: [] });
                    }
                }
            } catch (editError) {
                console.error(`Error removing buttons for auto-missed boss ${bossKey}:`, editError);
            }

            const now = new Date().getTime();
            currentBossData.isWindow = true;
            currentBossData.lastKilled = null;
            currentBossData.nextSpawnEstimateMin = now + currentBossData.minRespawnHours * 60 * 60 * 1000;
            if (currentBossData.maxRespawnHours && currentBossData.maxRespawnHours > currentBossData.minRespawnHours) {
                currentBossData.nextSpawnEstimateMax = now + currentBossData.maxRespawnHours * 60 * 60 * 1000;
            } else {
                currentBossData.nextSpawnEstimateMax = now + (currentBossData.minRespawnHours + 1) * 60 * 60 * 1000;
            }
            currentBossData.messageIdToTrack = null; 
            currentBossData.autoMissJob = null; 

            try {
                const channelForMessage = await client.channels.fetch(channelIdForAutoMissMessage).catch(() => null);
                 if (channelForMessage) {
                    await channelForMessage.send(`⌛ Boss **${currentBossData.name}** (${currentBossData.location}) was automatically marked as **missed** due to no action taken. Next *possible* time: ${formatNextSpawn(currentBossData)}`);
                } else {
                    console.warn(`AutoMiss: Could not find channel ${channelIdForAutoMissMessage} to send auto-miss message for boss ${currentBossData.name}.`);
                }
            } catch (sendError) {
                console.error(`Error sending auto-miss notification for ${bossKey}:`, sendError);
            }
            
            scheduleBossNotifications(guildId, bossKey); 
            saveBossData();

        } catch (e) {
            console.error(`Error in auto-miss timer for boss ${bossKey}:`, e);
        } finally {
            client.activeTimers.delete(timerKey); 
            const bossRef = client.bossData.get(guildId)?.get(bossKey);
            if (bossRef && bossRef.autoMissJob === timerKey) { 
                bossRef.autoMissJob = null;
            }
        }
    }, autoMissDelay);

    client.activeTimers.set(timerKey, timer);
    bossDataRef.autoMissJob = timerKey; 
}


function clearBossTimers(guildId, bossKey) {
    const types = ['pre', 'spawn', 'automiss'];
    types.forEach(type => {
        const timerKey = `${guildId}_${bossKey}_${type}`;
        const timer = client.activeTimers.get(timerKey);
        if (timer) {
            clearTimeout(timer);
            client.activeTimers.delete(timerKey);
        }
    });
    
    const guildBosses = client.bossData.get(guildId);
    if (guildBosses) {
        const boss = guildBosses.get(bossKey);
        if (boss) {
            boss.notificationJob = null;
            boss.spawnNotificationJob = null;
            boss.autoMissJob = null;
        }
    }
}

client.login(BOT_TOKEN)
    .catch(err => {
        console.error("Critical error during Discord login:", err);
        if (err.code === 'DisallowedIntents') {
            console.error("Error: Necessary Privileged Gateway Intents (Server Members Intent and/or Message Content Intent) are not enabled on the Discord Developer Portal for your bot!");
        } else if (err.message && err.message.includes('TOKEN_INVALID')) {
             console.error("Error: Invalid bot token. Please check your DISCORD_BOT_TOKEN.");
        }
        process.exit(1);
    });

process.on('unhandledRejection', error => {
    console.error('Unhandled promise rejection:', error);
});
process.on('uncaughtException', error => {
    console.error('Uncaught exception:', error);
});
