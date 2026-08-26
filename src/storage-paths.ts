import os from 'os';
import path from 'path';

/** ROSE_HOME that is actually usable — guards against 'undefined'/'null'/blank strings. */
export function envRoseHome(): string | undefined {
    const v = process.env.ROSE_HOME?.trim();
    return v && v !== 'undefined' && v !== 'null' ? v : undefined;
}

/** Persistent Rose runtime data, independent of the shell's current folder. */
export function roseDataPath(...parts: string[]): string {
    const home = envRoseHome() ?? path.join(os.homedir(), '.rose');
    return path.join(home, ...parts);
}
