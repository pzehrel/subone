import path from 'node:path';

export const projectRoot = process.env.SUBONE_ROOT
  ? path.resolve(process.env.SUBONE_ROOT)
  : path.resolve(__dirname, '../../..');
