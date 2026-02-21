import { Controller, Get, Res } from '@nestjs/common';
import { Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Public documentation endpoints — no auth required.
 * Serves markdown API docs so external teams (e.g. LeadBridge) can access them
 * without a workspace API key.
 */
@Controller('docs')
export class DocsController {
  @Get('call-connect')
  getCallConnectDocs(@Res() res: Response) {
    // Try paths from most likely to least likely depending on deployment layout.
    // In Railway: __dirname = /app/backend/dist  → ../../ = /app/ (project root)
    // Locally:    __dirname = .../backend/dist   → ../../ = project root
    const candidates = [
      path.join(__dirname, '../../API_FOR_INSTANT_CALL_LEADBRIDGE.md'),
      path.join(process.cwd(), '../API_FOR_INSTANT_CALL_LEADBRIDGE.md'),
      path.join(process.cwd(), 'API_FOR_INSTANT_CALL_LEADBRIDGE.md'),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        res.set('Content-Type', 'text/markdown; charset=utf-8');
        res.set('Cache-Control', 'public, max-age=300');
        res.send(fs.readFileSync(candidate, 'utf8'));
        return;
      }
    }

    res.status(404).json({ error: 'Documentation file not found' });
  }
}
