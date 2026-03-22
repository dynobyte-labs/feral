import winston from "winston";
import { config } from "./config.js";
import fs from "fs";

fs.mkdirSync(config.paths.logs, { recursive: true });

export const logger = winston.createLogger({
  level: config.logLevel,
  format: winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
      return `${timestamp} [${level.toUpperCase().padEnd(5)}] ${message}${metaStr}`;
    })
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message }) => {
          return `${timestamp} ${level} ${message}`;
        })
      ),
    }),
    new winston.transports.File({
      filename: `${config.paths.logs}/orchestrator.log`,
      maxsize: 10_000_000, // 10 MB
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: `${config.paths.logs}/error.log`,
      level: "error",
    }),
  ],
});
