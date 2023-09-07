import { readdir, readFile } from 'fs/promises';
import type { Dirent } from 'node:fs';
import path from 'path';
import { marked } from 'marked';
import hljs from 'highlight.js';

interface PackageJson {
  name: string;
  description: string;
  version: string;
  icon: string;
}

export interface Plugin {
  name: string;
  npmName: string;
  description: string;
  icon: string;
  markdownContent: string;
}

const pluginDirName = '../packages/';

/**
 * Get all plugin directories starting with `vendure-plugin`
 */
export async function getPluginDirectories(): Promise<Dirent[]> {
  return (await readdir(pluginDirName, { withFileTypes: true }))
    .filter((dir) => dir.isDirectory())
    .filter((dir) => dir.name.startsWith('vendure-plugin'));
}

export async function getPlugins(): Promise<Plugin[]> {
  const pluginDirectories = await getPluginDirectories();
  const plugins: Plugin[] = [];
  await Promise.all(
    pluginDirectories.map(async (r) => {
      const packageJsonFilePath = path.join(
        pluginDirName,
        r.name,
        'package.json'
      );
      const packageJson: PackageJson = JSON.parse(
        await readFile(packageJsonFilePath, 'utf8')
      );
      const readmeFilePath = path.join(pluginDirName, r.name, 'README.md');
      const readme: string = await readFile(readmeFilePath, 'utf8');
      // TODO remove "Docs here" line from readme
      const name = readme.split('\n')[0].replace('#', '').trim();
      const readmeHtml = parseReadme(readme);
      plugins.push({
        name,
        npmName: packageJson.name,
        description: packageJson.description,
        icon: packageJson.icon ?? 'package-variant-closed',
        markdownContent: readmeHtml,
      });
    })
  );
  return plugins;
}

/**
 * Parse raw Readme.md string to HTML
 */
export function parseReadme(readmeString: string): string {
  // `highlight` example uses https://highlightjs.org
  marked.setOptions({
    renderer: new marked.Renderer(),
    highlight: function (code, lang) {
      const language = hljs.getLanguage(lang) ? lang : 'plaintext';
      return hljs.highlight(code, { language }).value;
    },
    langPrefix: 'hljs language-', // highlight.js css expects a top-level 'hljs' class.
    pedantic: false,
    gfm: true,
    breaks: false,
    sanitize: false,
    // smartLists: true,
    smartypants: false,
    xhtml: false,
  });
  return marked.parse(readmeString);
}
