export interface Doubler { double(value: number): number }
export class NumberDoubler implements Doubler { double(value: number) { return value * 2; } }
export function doubleValue(value: number) { return new NumberDoubler().double(value); }
export const answer = doubleValue(3);
