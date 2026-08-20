// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';

const GIF_PROJECTS_ROOT = resolve('D:\\SpriteAnimProjects\\gif-projects');

function revealFrameSheetPlugin() {
	const middleware = (request, response, next) => {
		if (request.url !== '/api/reveal-frame-sheet' || request.method !== 'POST') return next();
		let body = '';
		request.on('data', (chunk) => { body += chunk; });
		request.on('end', () => {
			try {
				const { segments } = JSON.parse(body || '{}');
				if (!Array.isArray(segments) || !segments.length || segments.some((part) => typeof part !== 'string' || !part || part === '.' || part === '..' || /[\\/]/.test(part))) {
					throw new Error('Invalid frame-sheet path.');
				}
				const target = resolve(GIF_PROJECTS_ROOT, ...segments);
				if (!target.startsWith(`${GIF_PROJECTS_ROOT}${sep}`) || !existsSync(target) || !/^frame-sheet-.*\.png$/i.test(segments.at(-1))) {
					throw new Error('Frame-sheet file was not found.');
				}
				execFile('explorer.exe', [`/select,${target}`], (error) => {
					response.statusCode = error ? 500 : 204;
					if (error) response.end('Could not open File Explorer.');
					else response.end();
				});
			} catch (error) {
				response.statusCode = 400;
				response.end(error instanceof Error ? error.message : 'Invalid request.');
			}
		});
	};
	return {
		name: 'spritelab-reveal-frame-sheet',
		configureServer(server) { server.middlewares.use(middleware); },
		configurePreviewServer(server) { server.middlewares.use(middleware); },
	};
}

// https://astro.build/config
export default defineConfig({
	vite: {
		plugins: [tailwindcss(), revealFrameSheetPlugin()],
	},
});
