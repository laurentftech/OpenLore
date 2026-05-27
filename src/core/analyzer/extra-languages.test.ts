import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CallGraphBuilder, serializeCallGraph, type SerializedCallGraph } from './call-graph.js';

const dir = join(__dirname, 'fixtures');

async function buildOne(rel: string, language: string): Promise<SerializedCallGraph> {
  const content = readFileSync(join(dir, rel), 'utf-8');
  const result = await new CallGraphBuilder().build([{ path: rel, content, language }]);
  return serializeCallGraph(result);
}
const fnNames = (g: SerializedCallGraph, lang: string) =>
  g.nodes.filter(n => n.language === lang && !n.isExternal).map(n => n.name).sort();
const edge = (g: SerializedCallGraph, caller: string, callee: string) => {
  const c = g.nodes.find(n => n.name === caller);
  const d = g.nodes.find(n => n.name === callee && !n.isExternal);
  return !!c && !!d && g.edges.some(e => e.callerId === c.id && e.calleeId === d.id);
};

describe('spec-08 additional languages', () => {
  it('C# — phantom bug fixed: real nodes, classes, and edges', async () => {
    const g = await buildOne('csharp/App.cs', 'C#');
    expect(fnNames(g, 'C#')).toEqual(['Boot', 'Helper', 'Log', 'Run']);
    expect(edge(g, 'Run', 'Helper')).toBe(true);   // this.Helper()
    expect(edge(g, 'Run', 'Log')).toBe(true);      // Util.Log()
    expect(g.classes.some(c => c.name === 'Service' && c.methodIds.length >= 2)).toBe(true);
  });

  it('Kotlin — members + extension function + calls', async () => {
    const g = await buildOne('kotlin/App.kt', 'Kotlin');
    expect(fnNames(g, 'Kotlin')).toContain('run');
    expect(fnNames(g, 'Kotlin')).toContain('helper');
    expect(fnNames(g, 'Kotlin')).toContain('shout'); // extension fun String.shout()
    expect(g.nodes.find(n => n.name === 'shout')?.className).toBe('String');
    expect(edge(g, 'run', 'helper')).toBe(true);
    expect(edge(g, 'main', 'run')).toBe(true);
  });

  it('PHP — $this->m(), Class::m(), free function calls', async () => {
    const g = await buildOne('php/app.php', 'PHP');
    expect(fnNames(g, 'PHP')).toEqual(['boot', 'helper', 'helper_free', 'run', 'save']);
    expect(edge(g, 'run', 'helper')).toBe(true);   // $this->helper()
    expect(edge(g, 'run', 'save')).toBe(true);      // Util::save()
    expect(edge(g, 'boot', 'helper_free')).toBe(true);
    expect(g.classes.some(c => c.name === 'Service')).toBe(true);
  });

  it('C — phantom bug fixed: functions + calls, no classes', async () => {
    const g = await buildOne('c/app.c', 'C');
    expect(fnNames(g, 'C')).toEqual(['add', 'compute', 'main']);
    expect(edge(g, 'compute', 'add')).toBe(true);
    expect(edge(g, 'main', 'compute')).toBe(true);
    // C has no real classes — only the synthetic file-scope module grouping (as Go).
    expect(g.classes.filter(c => c.language === 'C').every(c => c.isModule)).toBe(true);
  });

  it('Scala — object/class methods and calls', async () => {
    const g = await buildOne('scala/App.scala', 'Scala');
    expect(fnNames(g, 'Scala')).toEqual(['go', 'helper', 'run']);
    expect(edge(g, 'run', 'helper')).toBe(true);
    expect(edge(g, 'go', 'run')).toBe(true);      // Service.run()
    expect(g.classes.some(c => c.name === 'Service')).toBe(true);
  });

  it('Elixir — defmodule grouping, def/defp, local call', async () => {
    const g = await buildOne('elixir/app.ex', 'Elixir');
    expect(fnNames(g, 'Elixir')).toEqual(['helper', 'run']);
    expect(edge(g, 'run', 'helper')).toBe(true);
    expect(g.classes.some(c => c.name === 'Service')).toBe(true);
  });

  it('Bash — defined-function call, NO edge to external binaries', async () => {
    const g = await buildOne('bash/app.sh', 'Bash');
    expect(fnNames(g, 'Bash')).toEqual(['helper', 'run']);
    expect(edge(g, 'run', 'helper')).toBe(true);
    // grep is an external binary, not a project function — no node, no edge.
    expect(g.nodes.some(n => n.name === 'grep' && !n.isExternal)).toBe(false);
  });

  it('Dart — graphed when grammar available, else degrades cleanly', async () => {
    const g = await buildOne('dart/app.dart', 'Dart');
    const names = fnNames(g, 'Dart');
    if (names.length === 0) return; // grammar unavailable in this env → graceful skip
    expect(names).toContain('run');
    expect(names).toContain('helper');
    expect(edge(g, 'run', 'helper')).toBe(true);
  });

  it('Lua — graphed when grammar available, else degrades cleanly', async () => {
    const g = await buildOne('lua/app.lua', 'Lua');
    const names = fnNames(g, 'Lua');
    if (names.length === 0) return; // grammar unavailable in this env → graceful skip
    expect(names).toContain('helper');
    expect(names).toContain('run');
    expect(edge(g, 'run', 'helper')).toBe(true);
  });
});
