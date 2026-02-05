// index.js
require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
} = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN;
const BOOSTER_CHANNEL_ID = process.env.BOOSTER_CHANNEL_ID;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;

if (!TOKEN) throw new Error("Missing DISCORD_TOKEN in .env");
if (!BOOSTER_CHANNEL_ID) throw new Error("Missing BOOSTER_CHANNEL_ID in .env");
if (!LOG_CHANNEL_ID) throw new Error("Missing LOG_CHANNEL_ID in .env");

// In-memory lock (fine for now). If you want persistence later, we can add Redis/DB.
const claimedByOrderId = new Map();

// Try to extract Order ID from embed/description/content
function extractOrderId(msg) {
  // 1) From embed description like "**Order ID:** TD-...."
  const emb = msg.embeds?.[0];
  const desc = emb?.description || "";
  const m1 = desc.match(/Order ID:\*\*\s*([A-Z0-9-]+)\b/i);
  if (m1) return m1[1];

  // 2) From embed title like "Claimable Job • TD-...."
  const title = emb?.title || "";
  const m2 = title.match(/\b(TD-[A-Z0-9-]+)\b/i);
  if (m2) return m2[1];

  // 3) From content
  const content = msg.content || "";
  const m3 = content.match(/\b(TD-[A-Z0-9-]+)\b/i);
  if (m3) return m3[1];

  return null;
}

function buildButtons(orderId, claimedUserId = null) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`claim:${orderId}`)
      .setLabel(claimedUserId ? "Claimed" : "Claim")
      .setStyle(ButtonStyle.Success)
      .setDisabled(!!claimedUserId),
    new ButtonBuilder()
      .setCustomId(`log:${orderId}`)
      .setLabel("Log")
      .setStyle(ButtonStyle.Secondary)
  );

  return [row];
}

function cloneEmbeds(msg) {
  // webhook embed objects can be reused; just shallow clone
  return msg.embeds?.map((e) => e.toJSON?.() ?? e) ?? [];
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // needed so we can read webhook text/content if any
  ],
  partials: [Partials.Channel, Partials.Message],
});

client.once(Events.ClientReady, () => {
  console.log(`✅ Bot online as ${client.user.tag}`);
});

// When webhook posts a new job in booster channel, repost with buttons
client.on(Events.MessageCreate, async (msg) => {
  try {
    // DEBUG: show what the bot is seeing
    console.log(
      `[MSG] channel=${msg.channelId} webhookId=${msg.webhookId ? "yes" : "no"} author=${msg.author?.tag}`
    );

    if (msg.channelId !== BOOSTER_CHANNEL_ID) return;

    // Ignore bot messages (so it doesn't repost itself)
    if (msg.author?.bot && !msg.webhookId) return;

    // Try extract order id from content/embeds
    const orderId = extractOrderId(msg);
    if (!orderId) {
      console.log("[MSG] No orderId detected, skipping.");
      return;
    }

    // If it already has buttons, do nothing
    if (msg.components?.length) {
      console.log("[MSG] Already has components, skipping.");
      return;
    }

    const embeds = cloneEmbeds(msg);
    const content = msg.content || "";

    const repost = await msg.channel.send({
      content,
      embeds,
      components: buildButtons(orderId, null),
    });

    console.log(`[REPOST] ${orderId} -> ${repost.url}`);

    // Only try deleting if it's a webhook message (cleaner channel)
    if (msg.webhookId) {
      await msg.delete().catch((e) => console.log("[DELETE FAIL]", e.message));
    }

    const logCh = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
    if (logCh) {
      await logCh.send(`🆕 Job reposted: **${orderId}**\n${repost.url}`).catch(() => {});
    }
  } catch (e) {
    console.error("MessageCreate error:", e);
  }
});


client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.isButton()) return;

    const [action, orderId] = interaction.customId.split(":");
    if (!orderId) return;

    // Only respond inside the booster channel
    if (interaction.channelId !== BOOSTER_CHANNEL_ID) {
      return interaction.reply({ content: "Wrong channel.", ephemeral: true });
    }

    if (action === "claim") {
      const already = claimedByOrderId.get(orderId);
      if (already) {
        const who = `<@${already}>`;
        return interaction.reply({
          content: `Too late — already claimed by ${who}.`,
          ephemeral: true,
        });
      }

      // Lock it
      claimedByOrderId.set(orderId, interaction.user.id);

      // Edit the message to show claimed + disable button
      const embeds = interaction.message.embeds?.map((e) => e.toJSON?.() ?? e) ?? [];
      // Add a small claimed line (edit first embed)
      if (embeds[0]) {
        embeds[0].footer = embeds[0].footer || {};
        embeds[0].footer.text = `Claimed by ${interaction.user.username}`;
      }

      await interaction.update({
        embeds,
        components: buildButtons(orderId, interaction.user.id),
      });

      // Log
      const logCh = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
      if (logCh) {
        await logCh.send(`✅ **${orderId}** claimed by <@${interaction.user.id}>`).catch(() => {});
      }
      return;
    }

    if (action === "log") {
      const claimed = claimedByOrderId.get(orderId);
      const claimedText = claimed ? `<@${claimed}>` : "Unclaimed";

      const logCh = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
      if (logCh) {
        await logCh.send(`📝 Log requested for **${orderId}** — status: ${claimedText}`).catch(() => {});
      }

      return interaction.reply({ content: "Logged ✅", ephemeral: true });
    }
  } catch (e) {
    console.error("Interaction error:", e);
    // If something goes wrong, at least respond
    if (interaction?.isRepliable?.() && !interaction.replied) {
      await interaction.reply({ content: "Error handling that.", ephemeral: true }).catch(() => {});
    }
  }
});

client.login(TOKEN);
