import {
  CategoryChannel,
  ChannelType,
  Client,
  TextChannel,
  Webhook,
} from "discord.js";
import dotenv from "dotenv";
import readline from "readline/promises";
import fs from "fs/promises";

dotenv.config();

const discordBotToken = process.env.DISCORD_BOT_TOKEN;
const discordStorageGuildId = process.env.DISCORD_STORAGE_GUILD_ID;
const discordStorageChannels =
  process.env.DISCORD_STORAGE_CHANNEL_COUNT &&
  parseInt(process.env.DISCORD_STORAGE_CHANNEL_COUNT);

if (!discordBotToken) {
  throw new Error("DISCORD_BOT_TOKEN is not defined");
}
if (!discordStorageGuildId) {
  throw new Error("DISCORD_STORAGE_GUILD_ID is not defined");
}
if (!discordStorageChannels) {
  throw new Error("DISCORD_STORAGE_CHANNEL_COUNT is not defined");
}
if (isNaN(discordStorageChannels)) {
  throw new Error("DISCORD_STORAGE_CHANNEL_COUNT is not a number");
}

const client = new Client({ intents: ["Guilds"] });

client.on("ready", async () => {
  console.log(`Logged in as ${client.user?.tag}, preparing...`);
  const guild = await client.guilds.fetch(
    process.env.DISCORD_STORAGE_GUILD_ID!
  );
  console.log(`Found guild ${guild.name} (${guild.id}), is this correct?`);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await rl.question("y/n: ");
  if (answer !== "y") {
    console.log("Aborting");
    client.destroy();
    process.exit(0);
  }

  const channels = await guild.channels.fetch();
  let archiveCategoryRaw = channels.find(
    (channel) =>
      channel &&
      channel.name === "archive" &&
      channel.type === ChannelType.GuildCategory
  );
  if (!archiveCategoryRaw) {
    console.log("Creating archive category");
    archiveCategoryRaw = await guild.channels.create({
      name: "archive",
      type: ChannelType.GuildCategory,
    });
  }
  const archiveCategory = archiveCategoryRaw as CategoryChannel;
  console.log(
    `Archive category: ${archiveCategory.name} (${archiveCategory.id})`
  );
  const archiveChannels = [
    ...channels
      .filter(
        (channel) =>
          channel &&
          channel.parentId === archiveCategory?.id &&
          channel.type === ChannelType.GuildText
      )
      .values(),
  ].filter((channel) => channel) as TextChannel[];
  console.log(`Found ${archiveChannels.length} archive channels`);

  if (archiveChannels.length < discordStorageChannels) {
    archiveChannels.push(
      ...(await Promise.all(
        Array.from(
          { length: discordStorageChannels - archiveChannels.length },
          async (_, i) => {
            console.log(`Creating archive channel ${archiveChannels.length + i}`);
            return await guild.channels.create({
              parent: archiveCategory,
              name: `archive-${archiveChannels.length + i}`,
            });
          }
        )
      ))
    );
  }

  const webhooks: Webhook[] = [];
  for (const channel of archiveChannels) {
    console.log(`Channel: ${channel.name} (${channel.id})`);

    const channelWebhooks = await channel.fetchWebhooks();
    if (channelWebhooks.size === 0) {
      console.log("Creating webhook");
      webhooks.push(await channel.createWebhook({ name: "archive" }));
    } else {
      console.log("Found webhook");
      webhooks.push(channelWebhooks.first()!);
    }
  }

  await fs.writeFile(
    "webhook_urls.txt",
    webhooks.map((webhook) => webhook.url).join("\n")
  );
  console.log("Done");
  client.destroy();
  process.exit(0);
});

client.login(discordBotToken);
