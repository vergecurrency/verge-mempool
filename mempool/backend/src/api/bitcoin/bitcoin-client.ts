import config from '../../config';
const bitcoin = require('../../rpc-api/index');
import { BitcoinRpcCredentials } from './bitcoin-api-abstract-factory';
import { isVerge } from '../verge/runtime';
import { parseVergeRpcJson } from '../verge/amounts';
import { adaptVergeRpcClient } from '../verge/rpc';

const nodeRpcCredentials: BitcoinRpcCredentials = {
  host: config.CORE_RPC.HOST,
  port: config.CORE_RPC.PORT,
  user: config.CORE_RPC.USERNAME,
  pass: config.CORE_RPC.PASSWORD,
  timeout: config.CORE_RPC.TIMEOUT,
  cookie: config.CORE_RPC.COOKIE ? config.CORE_RPC.COOKIE_PATH : undefined,
};

const client = new bitcoin.Client({ ...nodeRpcCredentials, parseResponse: isVerge ? parseVergeRpcJson : undefined });
export default isVerge ? adaptVergeRpcClient(client) : client;
