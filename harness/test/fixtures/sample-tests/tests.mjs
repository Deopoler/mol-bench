export default [
  {
    id: 'pass-state',
    title: 'state().seed equals seed set via bench.setSeed',
    async run(ctx) {
      await ctx.bench.setSeed(7);
      await ctx.bench.seek(500);
      await ctx.bench.renderFrame();
      const st = await ctx.bench.state();
      const ok = st.seed === 7 && st.clockMs === 500;
      return { pass: ok, detail: ok ? 'seed & clock matched' : JSON.stringify(st) };
    },
  },
  {
    id: 'crash-test',
    title: 'throwing test is caught and marked failed with detail',
    async run() {
      throw new Error('intentional boom');
    },
  },
];
