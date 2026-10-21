package main

// Doubler 表示将输入加倍的测试契约。
type Doubler interface {
	Double(int) int
}

// Number 是语义测试中契约的具体实现。
type Number struct{}

// Double 返回输入的两倍。
func (Number) Double(value int) int { return value * 2 }

func doubleValue(value int) int {
	var number Doubler = Number{}
	return number.Double(value)
}

func main() { println(doubleValue(3)) }
