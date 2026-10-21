trait Doubler { fn double(&self, value: i32) -> i32; }
struct Number;
impl Doubler for Number { fn double(&self, value: i32) -> i32 { value * 2 } }
fn double_value(value: i32) -> i32 { Number.double(value) }
fn main() { println!("{}", double_value(3)); }
