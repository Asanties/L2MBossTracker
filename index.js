// Import necessary classes from discord.js
const { Client, GatewayIntentBits, Collection, Partials, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField, StringSelectMenuBuilder } = require('discord.js');
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
client.bossData = new Collection();

const prefix = '!';
// This path is now simple and perfect for a VPS environment
const DATA_FILE_PATH = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname, 'boss_data.json'); 

// Timers for notifications
client.activeTimers = new Map();

const AUTO_MISS_TIMEOUT_MINUTES = 20;
const PRE_SPAWN_NOTIFICATION_MINUTES = 10; 


client.on('ready', () => {
    console.log(`Bot ${client.user.tag} successfully launched and ready!`);
    console.log(`Bot ID: ${client.user.id}`);
    console.log('------');
    client.user.setActivity(`Lineage 2M | ${prefix}help`, { type: 3 /* WATCHING */ });

    loadBossData();
    initializeBossTimers();
});

function saveBossData() {
    const dataToSave = {};
    client.bossData.forEach((guildBosses, guildId) => {
        dataToSave[guildId] = {};
        guildBosses.forEach((bossObject, bossKey) => {
            const bossToSave = { ...bossObject };
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
            
            client.bossData.clear(); 

            for (const guildId in loadedData) {
                const guildBossesCollection = new Collection();
                for (const bossKey in loadedData[guildId]) {
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
             console.log('Persistent boss_data.json not found. Checking for import file...');
             const importFilePath = path.join(__dirname, 'boss_data_import.json');
             if (fs.existsSync(importFilePath)) {
                 fs.copyFileSync(importFilePath, DATA_FILE_PATH);
                 console.log('Successfully copied data from boss_data_import.json to persistent storage.');
                 loadBossData(); // Recursive call to now load the copied file
             } else {
                 console.log('No import file found. Starting fresh.');
             }
        }
    } catch (error) {
        console.error('Failed to load boss data:', error);
        client.bossData = new Collection();
    }
}

function initializeBossTimers() {
    console.log('Initializing timers for loaded bosses...');
    const now = Date.now();
    client.bossData.forEach((guildBosses, guildId) => {
        guildBosses.forEach((boss, bossKey) => {
            if (boss.nextSpawnEstimateMin && boss.nextSpawnEstimateMin > now) {
                console.log(`Re-scheduling notifications for ${boss.name} (${bossKey}) in guild ${guildId}`);
                scheduleBossNotifications(guildId, bossKey);
            }
            if (boss.messageIdToTrack && boss.spawnNotificationJob === null && boss.autoMissJob === null) {
                 console.log(`Found active message with buttons for ${boss.name} (${bossKey}). Re-scheduling auto-miss timer.`);
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
                new ButtonBuilder().setCustomId('help_setchannel').setLabel('Notify Channel').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('help_restart').setLabel('Server Restart').setStyle(ButtonStyle.Danger)
            );

        await message.channel.send({ embeds: [helpEmbed], components: [row1, row2] });
        return;
    }

    if (commandName === 'restart') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return message.reply('You must be an administrator to use this command.');
        }

        const restartEmbed = new EmbedBuilder()
            .setColor(0xFF4500)
            .setTitle('🚨 Server Restart Confirmation')
            .setDescription('This action will trigger spawn notifications for **all** tracked bosses.\nUse this after a server maintenance or restart.\n\n**Are you sure you want to proceed?**');
        
        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('server_restart_confirm')
                    .setLabel('Confirm (Server ON)')
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId('server_restart_cancel')
                    .setLabel('Cancel')
                    .setStyle(ButtonStyle.Secondary)
            );
        
        await message.reply({ embeds: [restartEmbed], components: [row] });
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
        await message.reply(`Boss **${bossName}** (Location: ${location}, Respawn: ${minRespawnHours}${maxRespawnHours ? `-${maxRespawnHours}` : ''} hrs) added. Notifications in channel <#${notificationChannelId}>.`);
        saveBossData();
    } else if (commandName === 'killed') {
        if (args.length < 1) {
            return message.reply(`Usage: ${prefix}killed "<boss_name>" ["YYYY-MM-DD HH:MM"]`);
        }
        const bossNameArg = args[0];
        const bossKey = bossNameArg.toLowerCase().replace(/\s+/g, '_');
        const boss = guildBosses.get(bossKey);

        if (!boss) {
            return message.reply(`Boss "${bossNameArg}" not found.`);
        }

        let killTimestamp = new Date().getTime(); 

        if (args.length > 1) {
            const timeInputString = args[1];
            let parsedDate;
            parsedDate = new Date(timeInputString);
            
            if (isNaN(parsedDate.getTime())) {
                return message.reply(`Invalid time format: "${timeInputString}". Please use a clear format like \`"YYYY-MM-DD HH:MM"\`.`);
            }
            
            killTimestamp = parsedDate.getTime();
        }

        updateBossAsKilled(guildId, bossKey, killTimestamp, message.channel, null);
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
        if (guildBosses.size === 0) {
            return message.reply('There are no bosses to remove.');
        }

        const options = guildBosses.map(boss => ({
            label: boss.name,
            description: `Location: ${boss.location}`,
            value: boss.name.toLowerCase().replace(/\s+/g, '_') // Use the bossKey as value
        }));

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('remove_boss_select')
            .setPlaceholder('Select a boss to remove')
            .addOptions(options);

        const row = new ActionRowBuilder().addComponents(selectMenu);

        await message.reply({
            content: 'Please select the boss you want to remove from the list below:',
            components: [row],
            ephemeral: true // Make it visible only to the user who ran the command
        });
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
    // Handle Dropdown Menu for Removing a Boss
    if (interaction.isStringSelectMenu() && interaction.customId === 'remove_boss_select') {
        const bossKeyToRemove = interaction.values[0];
        const guildBosses = client.bossData.get(interaction.guildId);
        const bossToRemove = guildBosses.get(bossKeyToRemove);
        
        if (bossToRemove) {
            clearBossTimers(interaction.guildId, bossKeyToRemove);
            guildBosses.delete(bossKeyToRemove);
            saveBossData();
            
            await interaction.update({ content: `✅ Boss **${bossToRemove.name}** has been successfully removed.`, components: [] });
        } else {
            await interaction.update({ content: 'Error: Could not find the selected boss. It might have been removed already.', components: [] });
        }
        return;
    }


    if (!interaction.isButton()) return;

    if (interaction.customId.startsWith('help_')) {
        const helpCommand = interaction.customId.split('_')[1];
        let helpText = 'Command Information:\n';
        let ephemeral = true;

        switch (helpCommand) {
            case 'addboss':
                helpText += `**${prefix}addboss "<name>" "<location>" <min_hr> [max_hr] [channel_id]**\n`;
                helpText += 'Adds a new boss to track.';
                break;
            case 'killed':
                helpText += `**${prefix}killed "<name>" ["time"]**\n`;
                helpText += 'Marks a boss as killed. If no time is given, uses the current time.';
                break;
            case 'status':
                helpText += `**${prefix}status [name]**\n`;
                helpText += 'Shows the status of all tracked bosses or a specific boss.';
                break;
            case 'removeboss':
                helpText += `**${prefix}removeboss**\n`;
                helpText += 'Opens an interactive menu to select a boss to remove.';
                break;
            case 'setchannel':
                helpText += `**${prefix}setchannel "<name>" <channel_id>**\n`;
                helpText += 'Sets or changes the notification channel for a specific boss.';
                break;
            case 'restart':
                helpText += `**${prefix}restart**\n`;
                helpText += 'Initiates a server restart sequence, triggering spawn notifications for all bosses. **(Admin only)**';
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

    if (interaction.customId === 'server_restart_confirm') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return interaction.reply({ content: 'You must be an administrator to confirm this action.', ephemeral: true });
        }
        
        await interaction.update({ content: 'Acknowledged! Triggering spawn notifications for all bosses...', components: [] });
        
        const guildBosses = client.bossData.get(interaction.guildId);
        if (guildBosses && guildBosses.size > 0) {
            guildBosses.forEach((boss, bossKey) => {
                console.log(`Server restart: Triggering spawn for ${boss.name}`);
                clearBossTimers(interaction.guildId, bossKey);
                triggerSpawnNotification(interaction.guildId, bossKey);
            });
        } else {
             await interaction.followUp({ content: 'No bosses found to notify about.', ephemeral: true });
        }
        return;
    }

    if (interaction.customId === 'server_restart_cancel') {
        await interaction.update({ content: 'Server restart sequence cancelled.', components: [] });
        return;
    }


    const [action, bossKeyFromId, guildIdFromId] = interaction.customId.split('_'); 
    
    if (guildIdFromId !== interaction.guildId) {
        console.warn(`Mismatched guildId in customId: ${guildIdFromId} vs interaction.guildId: ${interaction.guildId}`);
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

// NEW HELPER FUNCTION TO SEND SPAWN NOTIFICATION
async function triggerSpawnNotification(guildId, bossKey) {
    const guildBosses = client.bossData.get(guildId);
    if (!guildBosses) return;
    const boss = guildBosses.get(bossKey);
    if (!boss) return;

    try {
        const notifyChannel = await client.channels.fetch(boss.notificationChannelId || boss.originalChannelId).catch(() => null);
        if (notifyChannel) {
            const spawnEmbed = new EmbedBuilder()
                .setColor(0xFF4500) // OrangeRed
                .setTitle(`🔥 ${boss.name} - SPAWNED!`)
                .setDescription(`**Location:** ${boss.location}\nPlease report the status below.`)
                .setTimestamp();

            if (boss.isWindow) {
                spawnEmbed.setTitle(`⏳ ${boss.name} - WINDOW OPEN!`);
                if (boss.nextSpawnEstimateMax) {
                    spawnEmbed.addFields({ name: 'Window Ends', value: `<t:${Math.floor(new Date(boss.nextSpawnEstimateMax).getTime() / 1000)}:R>` });
                }
            }

            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`dead_${bossKey}_${guildId}`)
                        .setLabel('Killed')
                        .setStyle(ButtonStyle.Success)
                        .setEmoji('✅'),
                    new ButtonBuilder()
                        .setCustomId(`miss_${bossKey}_${guildId}`)
                        .setLabel('Missed')
                        .setStyle(ButtonStyle.Secondary)
                        .setEmoji('🤷'),
                    new ButtonBuilder()
                        .setCustomId(`notappeared_${bossKey}_${guildId}`)
                        .setLabel('Did Not Appear')
                        .setStyle(ButtonStyle.Danger)
                        .setEmoji('🚫'),
                );

            const sentMessage = await notifyChannel.send({
                content: '@everyone', // Pinging everyone
                embeds: [spawnEmbed],
                components: [row]
            });
            
            const bossRef = client.bossData.get(guildId)?.get(bossKey);
            if (bossRef) { 
                bossRef.messageIdToTrack = sentMessage.id;
                scheduleAutoMissTimer(guildId, bossKey, sentMessage.id, notifyChannel.id);
                saveBossData(); 
            }
        } else {
             console.warn(`Spawn: Could not find channel for boss ${boss.name} (${boss.notificationChannelId || boss.originalChannelId})`);
        }
    } catch (e) { console.error("Error sending spawn notification:", e); }
}


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
                    const preSpawnEmbed = new EmbedBuilder()
                        .setColor(0xFFFF00) // Yellow
                        .setTitle(`🔔 ${currentBossData.name} - Spawning Soon!`)
                        .setDescription(`**Location:** ${currentBossData.location}`)
                        .addFields(
                            { name: 'Expected Time', value: `${formatNextSpawn(currentBossData)}` }
                        )
                        .setTimestamp();
                    
                    if (currentBossData.isWindow) {
                        preSpawnEmbed.setFooter({ text: 'This is the start of the respawn window.' });
                    }
                    
                    await notifyChannel.send({ embeds: [preSpawnEmbed] });

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
            const currentBossData = client.bossData.get(guildId)?.get(bossKey); 
            if (!currentBossData || currentBossData.spawnNotificationJob !== timerKey) return; 

            await triggerSpawnNotification(guildId, bossKey);
            
            client.activeTimers.delete(timerKey);
            const bossRef = client.bossData.get(guildId)?.get(bossKey);
            if (bossRef) {
                 bossRef.spawnNotificationJob = null;
            }
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
                    const autoMissEmbed = new EmbedBuilder()
                        .setColor(0x778899) // LightSlateGray
                        .setTitle(`⌛ ${currentBossData.name} - Automatically Missed`)
                        .setDescription(`No status was reported for **${currentBossData.name}** (${currentBossData.location}). It has been marked as **missed** automatically.`)
                        .addFields(
                            { name: 'Next Possible Time', value: formatNextSpawn(currentBossData) }
                        )
                        .setFooter({ text: 'This is not an exact time!' })
                        .setTimestamp();
        
                    await channelForMessage.send({ embeds: [autoMissEmbed] });
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
    saveBossData(); 
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
