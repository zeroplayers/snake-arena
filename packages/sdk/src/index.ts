/** What a bot returns each tick. Full state types land with #6 and #7. */
export interface BotAction {
  /** Steering, clamped to [-1, 1]: -1 is full left, 1 is full right. */
  turn: number;
  /** Spend length to move faster. */
  boost?: boolean;
}
