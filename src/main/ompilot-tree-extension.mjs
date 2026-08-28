export default function ompilotTreeExtension(pi) {
  pi.registerCommand('ompilot-internal-tree', {
    description: 'Navigate the current session tree for Ompilot',
    handler: async (args, ctx) => {
      const entryId = args.trim()
      if (!/^[a-f0-9]{8}$/i.test(entryId)) {
        throw new Error('Invalid session entry ID')
      }
      const result = await ctx.navigateTree(entryId, { summarize: false })
      if (result.cancelled) {
        throw new Error('Session tree navigation was cancelled')
      }
    }
  })
}
