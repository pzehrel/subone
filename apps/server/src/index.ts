import { serve } from '@hono/node-server';
import { createApp } from './app';
import { appConfig, setGlobalNodesCache } from './context';
import {
  ensureCustomSource,
  ensureCustomProxyGroup,
  ensureAllSourceProxyGroups,
  collectNodesFromSources,
} from './services/profile-service';
import { saveConfig } from './storage/db';

// Run initial source and group alignment
ensureCustomSource(appConfig);
ensureCustomProxyGroup(appConfig);
ensureAllSourceProxyGroups(appConfig);
saveConfig(appConfig);

// Initialize in-memory cache directly from persisted source nodes
setGlobalNodesCache(collectNodesFromSources(appConfig));

const app = createApp();
const PORT = Number(process.env.PORT || appConfig.settings?.port || 3456);

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log('-------------------------------------------------------');
  console.log(`SubOne listening on http://localhost:${PORT}`);
  console.log(`Authentication: ${appConfig.settings?.adminPassword ? 'Enabled' : 'Disabled (No password set)'}`);
  if (appConfig.profiles && appConfig.profiles.length > 0) {
    console.log(`Default subscription: http://localhost:${PORT}/s/${appConfig.profiles[0].token}`);
  }
  console.log('-------------------------------------------------------');
});

export default app;
