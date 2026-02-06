require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  PermissionFlagsBits,
} = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN;
const BOOSTER_CHANNEL_ID = process.env.BOOSTER_CHANNEL_ID;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;
const TICKET_CATEGORY_ID = process.env.TICKET_CATEGORY_ID;

if (!TOKEN) throw new Error("Missing DISCORD_TOKEN");
if (!BOOSTER_CHANNEL_ID) throw new Error("Missing BOOSTER_CHANNEL_ID");
if (!LOG_CHANNEL_ID) throw new Error("Missing LOG_CHANNEL_ID");
if (!TICKET_CATEGORY_ID) throw new Error("Missing TICKET_CATEGORY_ID");

// ---------------- In-memory state (rebuilt from logs) ----------------
const claimedByOrderId = new Map();        // orderId -> boosterUserId
const ticketChannelByOrderId = new Map(); // orderId -> ticketChannelId
const customerByOrderId = new Map();      // orderId -> customerUserId

// ---------------- Helpers ----------------
const normalizeOrderId = (s) => String(s || "").trim().toUpperCase();

function extractOrderId(text) {
  const m = String(text || "").match(/\b(TD-[A-Z0-9-]{6,})\b/i);
  return m ? normalizeOrderId(m[1]) : null;
}

function buildButtons(orderId, claimedUserId = null) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`claim:${orderId}`)
        .setLabel(claimedUserId ? "Claimed" : "Claim")
        .setStyle(ButtonStyle.Success)
        .setDisabled(!!claimedUserId),
      new ButtonBuilder()
        .setCustomId(`log:${orderId}`)
        .setLabel("Log")
        .setStyle(ButtonStyle.Secondary)
    ),
  ];
}

async function logRecord(client, line) {
  const ch = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
  if (ch) await ch.send(line).catch(() => {});
}

function parseLog(line) {
  return {
    order: line.match(/\border=([A-Z0-9-]+)/i)?.[1],
    booster: line.match(/\bbooster=(\d+)/)?.[1],
    customer: line.match(/\bcustomer=(\d+)/)?.[1],
    channel: line.match(/\bchannel=(\d+)/)?.[1],
    tag: line.match(/^\[(\w+)\]/)?.[1],
  };
}

async function rebuildState(client) {
  const ch = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
  if (!ch) return;

  const msgs = await ch.messages.fetch({ limit: 150 }).catch(() => null);
  if (!msgs) return;

  for (const m of msgs.values()) {
    const p = parseLog(m.content);
    if (!p.order || !p.tag) continue;

    if (p.tag === "CLAIM" && p.booster)
      claimedByOrderId.set(p.order, p.booster);

    if (p.tag === "LINK" && p.channel && p.customer) {
      ticketChannelByOrderId.set(p.order, p.channel);
      customerByOrderId.set(p.order, p.customer);
    }
  }

  console.log(
    `🔁 State rebuilt | claims=${claimedByOrderId.size}, tickets=${ticketChannelByOrderId.size}`
  );
}

// ---------------- Client ----------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

client.once(Events.ClientReady, async () => {
  console.log(`✅ Bot online as ${client.user.tag}`);
  await rebuildState(client);
});

// ---------------- Ticket channel listener ----------------
client.on(Events.MessageCreate, async (msg) => {
  try {
    if (msg.author?.bot) return;

    // Only ticket channels created by ticket bot
    if (msg.channel?.parentId !== TICKET_CATEGORY_ID) return;

    const orderId = extractOrderId(msg.content);
    if (!orderId) return;

    // Link ticket to order
    if (!ticketChannelByOrderId.has(orderId)) {
      ticketChannelByOrderId.set(orderId, msg.channel.id);
      customerByOrderId.set(orderId, msg.author.id);

      await logRecord(
        client,
        `[LINK] order=${orderId} channel=${msg.channel.id} customer=${msg.author.id}`
      );
    }

    await msg.reply(
      "✅ Order linked. If a booster is assigned, I’ll add them here automatically."
    ).catch(() => {});

    // If booster already claimed, add them now
    const boosterId = claimedByOrderId.get(orderId);
    if (boosterId) {
      await msg.channel.permissionOverwrites.edit(boosterId, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
      });

      await msg.channel.send(
        `👋 Booster assigned: <@${boosterId}>`
      ).catch(() => {});
    }
  } catch (e) {
    console.error("Ticket handler error:", e);
  }
});

// ---------------- Booster job buttons ----------------
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.isButton()) return;

    const [action, rawOrderId] = interaction.customId.split(":");
    const orderId = normalizeOrderId(rawOrderId);

    if (interaction.channelId !== BOOSTER_CHANNEL_ID) {
      return interaction.reply({ content: "Wrong channel.", ephemeral: true });
    }

    if (action === "claim") {
      if (claimedByOrderId.has(orderId)) {
        return interaction.reply({
          content: `Already claimed by <@${claimedByOrderId.get(orderId)}>`,
          ephemeral: true,
        });
      }

      claimedByOrderId.set(orderId, interaction.user.id);
      await logRecord(
        client,
        `[CLAIM] order=${orderId} booster=${interaction.user.id}`
      );

      // Update message UI
      const embeds = interaction.message.embeds.map((e) => e.toJSON());
      if (embeds[0]) {
        embeds[0].footer = { text: `Claimed by ${interaction.user.username}` };
      }

      await interaction.update({
        embeds,
        components: buildButtons(orderId, interaction.user.id),
      });

      // Add booster to ticket channel if exists
      const ticketChannelId = ticketChannelByOrderId.get(orderId);
      if (ticketChannelId) {
        const ch = await client.channels.fetch(ticketChannelId).catch(() => null);
        if (ch) {
          await ch.permissionOverwrites.edit(interaction.user.id, {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true,
          });

          await ch.send(
            `👋 Booster assigned: <@${interaction.user.id}>`
          ).catch(() => {});

          return interaction.followUp({
            content: `Added you to the customer ticket: <#${ch.id}>`,
            ephemeral: true,
          });
        }
      }

      return interaction.followUp({
        content:
          "Customer hasn’t pasted the Order ID in a ticket yet. I’ll add you automatically once they do.",
        ephemeral: true,
      });
    }

    if (action === "log") {
      await logRecord(client, `📝 Log requested for ${orderId}`);
      return interaction.reply({ content: "Logged ✅", ephemeral: true });
    }
  } catch (e) {
    console.error("Interaction error:", e);
  }
});

client.login(TOKEN);
