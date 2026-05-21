import * as lark from '@larksuiteoapi/node-sdk';
import type { Logger } from '../utils/logger.js';

export interface FeishuClients {
  client: lark.Client;
  wsClient: lark.WSClient;
}

export function createFeishuClients(
  appId: string,
  appSecret: string,
  logger: Logger,
): FeishuClients {
  const client = new lark.Client({
    appId,
    appSecret,
    disableTokenCache: false,
  });

  const wsClient = new lark.WSClient({
    appId,
    appSecret,
    loggerLevel: lark.LoggerLevel.info,
  });

  logger.info('Feishu clients created');
  return { client, wsClient };
}
