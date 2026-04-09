import type { Command } from '../../commands.js'

const bridge = {
  type: 'local-jsx',
  name: 'remote-control',
  aliases: ['rc'],
  description: 'Launch or reveal the local remote-control web app',
  argumentHint: '',
  isEnabled: () => true,
  isHidden: false,
  immediate: true,
  load: () => import('./bridge.js'),
} satisfies Command

export default bridge
