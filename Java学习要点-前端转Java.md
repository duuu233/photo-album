# 前端 JS 开发者的 Java 学习要点(AI 加持版)

> 面向:有多年 JS 经验、想系统上手 Java 的开发者。
> 目标:在 AI 能帮你写语法的时代,你需要掌握的是**看懂、判断、调试、指挥** AI 产出的能力。
> 用法:反复复习。每节都标注了「要不要背」,以及与 JS 的对照。

---

## 📖 如何使用本文档

三种标记:

| 标记 | 含义 | AI 时代为什么仍要掌握 |
|------|------|----------------------|
| 🧠 **原理** | 必须理解底层机制 | AI 写的代码有 bug 时,只有你懂原理才能发现;语法 AI 会写,判断得靠你 |
| 📌 **记忆** | 需要记住的固定事实/规则 | 读代码、code review 时反应得过来,不用每次都查 |
| 🌉 **桥接** | 直接对照你已有的 JS 知识 | 用旧知识快速建立新映射,少走弯路 |

**核心学习哲学(重要):**
> AI 负责写语法和样板代码,**你负责三件 AI 干不好的事**:
> 1. **读得懂** —— 判断 AI 生成的代码是否正确、是否地道(idiomatic)
> 2. **调得动** —— 出 bug 时(尤其空指针、并发、类型问题)能定位原因
> 3. **指挥对** —— 知道该让 AI 用什么集合、什么设计、什么依赖
>
> 所以:**语法细节可以少背,运行机制和"坑"必须懂透。**

---

## 0. 🧠 心智转变(最重要,先建立世界观)

从 JS 到 Java,最先要扭转的几个观念:

| 维度 | JavaScript | Java |
|------|-----------|------|
| 类型 | 动态类型,运行时才知道类型 | **静态类型**,编译期就检查,类型写死 |
| 运行 | 解释执行(引擎即时编译) | **先编译成字节码,再由 JVM 运行** |
| 出错时机 | 大量错误运行时才暴露 | **大量错误编译期就拦住**(这是 Java 的核心优势) |
| 面向对象 | 基于原型(prototype) | 基于**类(class)**,严格 OOP |
| 线程 | **单线程** + 事件循环 | **多线程**,真并行(最大差异,后面专讲) |
| 空值 | `null` 和 `undefined` 两种 | 只有 `null`(空指针 NPE 是头号 bug) |
| 一切皆对象? | 函数、对象都是一等公民 | 有**基本类型**(非对象)和**引用类型**之分 |
| 组织单位 | 模块(ESM/CJS)、文件 | **包(package)+ 类**,一个 public 类通常一个文件 |

> 🧠 一句话记住差异根源:**Java 用"编译期的严格"换取"运行期的可靠",JS 用"运行期的灵活"换取"写起来快"。** 你转 Java 后会觉得"啰嗦",但那些啰嗦大多是在帮你提前拦 bug。

---

## 1. 🧠 运行机制与编译流程

JS 你写完直接跑;Java 中间多了"编译"这一步,必须理解这条链路。

```
   .java 源码
      │  javac 编译
      ▼
   .class 字节码(bytecode)  ← 平台无关的中间码
      │  JVM 加载并执行(解释 + JIT 即时编译成机器码)
      ▼
   在操作系统上运行
```

**📌 必须分清三个缩写:**

| 缩写 | 全称 | 是什么 | 类比 |
|------|------|--------|------|
| **JVM** | Java Virtual Machine | 运行字节码的虚拟机 | 类似 V8 引擎 |
| **JRE** | Java Runtime Environment | JVM + 核心类库,**只能运行** | 只装了运行时 |
| **JDK** | Java Development Kit | JRE + 编译器(javac)等**开发工具** | 开发要装这个 |

> 🧠 **"一次编译,到处运行"(Write Once, Run Anywhere)**:字节码平台无关,不同操作系统装各自的 JVM 就能跑同一份 `.class`。这是 Java 当年崛起的核心卖点。

> 📌 **版本认知**:优先学 **Java 17 或 21**(都是 LTS 长期支持版)。别学老的 Java 8 语法风格(虽然企业存量多),新特性(var/record/switch 表达式/文本块)能让代码接近现代 JS 的简洁度。

---

## 2. 🧠📌 类型系统:静态类型 + 基本类型 vs 引用类型

这是 JS 开发者第一个大坎。

### 2.1 🌉 变量必须声明类型

```js
// JS
let name = "Tom";
let age = 18;
const PI = 3.14;
```
```java
// Java
String name = "Tom";      // 类型写在前面
int age = 18;
final double PI = 3.14;    // final ≈ const(不可重新赋值)

var msg = "hi";           // Java 10+ 可用 var 让编译器推断类型(仍是静态类型!只是省得写)
```

> 🌉 `var` 只是**省略书写**,不是 JS 的动态类型。`var x = 1;` 之后 x 永远是 int,不能再 `x = "hi"`。

### 2.2 🧠 基本类型(primitive) vs 引用类型(reference)—— 核心区别

JS 里数字、布尔背后都是对象(有方法)。Java 里**基本类型不是对象**,直接存值,性能高。

**📌 8 种基本类型(要记住常用的):**

| 类型 | 大小 | 范围/说明 | JS 对应 |
|------|------|-----------|---------|
| `int` | 32 位 | 约 ±21 亿(最常用整数) | number |
| `long` | 64 位 | 超大整数,字面量加 `L`:`100L` | BigInt-ish |
| `double` | 64 位 | 小数默认类型 | number |
| `float` | 32 位 | 小数,字面量加 `f`:`1.5f` | - |
| `boolean` | - | 只有 `true`/`false` | boolean |
| `char` | 16 位 | **单个字符**,用单引号:`'A'` | - |
| `byte` | 8 位 | 小整数,处理二进制常用 | - |
| `short` | 16 位 | 很少用 | - |

**引用类型**:除基本类型外的一切(String、数组、你自己的类、集合……),变量存的是**对象的引用(地址)**,对象在堆里。

```java
int a = 5;              // 栈上直接存 5(基本类型)
String s = "hi";        // s 存的是引用,"hi" 对象在堆里
int[] arr = {1, 2, 3};  // arr 存引用,数组在堆里
```

### 2.3 🧠 自动装箱/拆箱(Autoboxing)—— 隐藏的坑

每个基本类型都有一个**包装类**(对象版):`int`→`Integer`,`double`→`Double`,`boolean`→`Boolean`……

```java
int a = 5;
Integer b = 5;    // 自动装箱:int → Integer 对象
int c = b;        // 自动拆箱:Integer → int
```

> 🧠 **为什么要懂**:集合(如 `List`)只能装对象,不能装基本类型,所以到处发生装箱拆箱。拆箱一个 `null` 的 `Integer` 会直接 **NPE 空指针崩溃**——这是极隐蔽的 bug:
> ```java
> Integer count = map.get("key");  // key 不存在,count = null
> if (count > 0) { ... }           // 拆箱 null → 抛 NullPointerException!
> ```

### 2.4 📌 整数除法陷阱(JS 老手最容易栽)

```js
// JS
5 / 2   // 2.5
```
```java
// Java
5 / 2       // 2 !! 两个 int 相除结果还是 int,直接截断小数
5.0 / 2     // 2.5,有一个是小数就 OK
(double) 5 / 2  // 2.5,强制转换
```

> 📌 记住:**int/int = int**。算平均值、比例时务必注意,这个 bug AI 有时也会写错。

---

## 3. 🧠 `==` vs `equals()` —— JS 开发者的头号大坑

JS 里有 `==`(宽松) 和 `===`(严格)。Java 完全不同:

- **`==`** 比较的是**引用是不是同一个对象**(基本类型时才是比值)
- **`.equals()`** 比较的是**内容是否相等**

```java
String a = new String("hello");
String b = new String("hello");

a == b          // false! 两个不同对象,引用不同
a.equals(b)     // true,内容相同
```

> 🧠 **铁律**:**比较对象内容,永远用 `.equals()`,不要用 `==`**。字符串、包装类、你自己的类都是这样。用 `==` 比字符串是新手最常见 bug。

### 3.1 🧠 更阴险的:Integer 缓存

```java
Integer x = 127, y = 127;
x == y          // true(-128~127 有缓存,是同一个对象)

Integer p = 128, q = 128;
p == q          // false! 超出缓存范围,是两个对象
```

> 🧠 这个例子能彻底帮你理解"`==` 比引用"。**结论还是:比值用 `.equals()`,或拆成基本类型 `int` 比。**

### 3.2 📌 配套规则:重写 equals 必重写 hashCode

如果你自定义类想用内容比较,得同时重写 `equals()` 和 `hashCode()`(否则放进 `HashMap`/`HashSet` 会出错)。现代做法是用 `record`(见第 12 节)自动生成,或让 IDE/AI 生成。

---

## 4. 🧠 面向对象(OOP):Java 的骨架

JS 的 `class` 是原型的语法糖;Java 的类是货真价实的一等公民。

### 4.1 🌉 类、字段、方法、构造器

```java
public class User {
    // 字段(成员变量)
    private String name;
    private int age;

    // 构造器(相当于 JS 的 constructor)
    public User(String name, int age) {
        this.name = name;
        this.age = age;
    }

    // 方法
    public String greet() {
        return "Hi, I'm " + this.name;
    }

    // getter / setter(Java 约定,后面讲 record 可省)
    public String getName() { return name; }
    public void setName(String name) { this.name = name; }
}

// 使用
User u = new User("Tom", 18);  // new 关键字创建实例
u.greet();
```

### 4.2 🧠 四大访问修饰符(封装的基础)—— 要记住

| 修饰符 | 同类 | 同包 | 子类 | 任何地方 | 记忆 |
|--------|:---:|:---:|:---:|:---:|------|
| `public` | ✅ | ✅ | ✅ | ✅ | 全公开 |
| `protected` | ✅ | ✅ | ✅ | ❌ | 子类+同包可见 |
| (默认,不写) | ✅ | ✅ | ❌ | ❌ | 包私有 |
| `private` | ✅ | ❌ | ❌ | ❌ | 只自己 |

> 🌉 JS 现在也有 `#private`,但 Java 的访问控制是**语言核心**,处处都要写。习惯:**字段一律 `private`,通过方法暴露**(封装)。

### 4.3 🧠 三大特性

1. **封装(Encapsulation)**:字段私有,行为通过方法暴露。
2. **继承(Inheritance)**:`extends`,子类复用父类。Java **单继承**(一个类只能有一个父类,不像 JS 也是单继承但更灵活)。
3. **多态(Polymorphism)**:父类引用指向子类对象,调用时执行子类实现。

```java
class Animal {
    public String sound() { return "..."; }
}
class Dog extends Animal {
    @Override                                  // 注解:声明这是重写,写错会编译报错
    public String sound() { return "Woof"; }
}

Animal a = new Dog();   // 多态:声明类型 Animal,实际是 Dog
a.sound();              // "Woof" —— 运行时按实际类型调用
```

### 4.4 🧠 接口(interface) vs 抽象类(abstract class)—— 高频考点/高频用

| | 接口 interface | 抽象类 abstract class |
|---|---|---|
| 定位 | **能做什么**(契约/能力) | **是什么**(半成品父类) |
| 实现数量 | 一个类可实现**多个** | 只能继承**一个** |
| 字段 | 只能是常量 | 可有普通字段 |
| 方法 | 方法签名(Java 8+ 可有默认方法) | 可有具体方法 |
| 关键字 | `implements` | `extends` |

```java
interface Flyable {
    void fly();                              // 抽象方法,实现类必须写
    default void land() {                    // Java 8+ 默认方法
        System.out.println("landing");
    }
}

class Bird implements Flyable {
    public void fly() { System.out.println("flap"); }
}
```

> 🧠 **经验法则**:优先用接口(灵活、可多实现),抽象类用于多个子类共享具体代码时。Spring 生态大量基于接口编程。

### 4.5 🧠 重载(Overload) vs 重写(Override)—— 别搞混

- **重载 Overload**:同一个类里,**同名但参数不同**的多个方法(JS 没有,JS 靠一个函数判断参数)。
  ```java
  void print(int x) {}
  void print(String x) {}      // 重载:参数类型不同
  void print(int x, int y) {}  // 重载:参数个数不同
  ```
- **重写 Override**:子类**重新实现**父类的方法(见 4.3),签名必须一致,加 `@Override`。

---

## 5. 📌 关键字与修饰符(需要记忆的固定含义)

这些是读代码时必须秒懂的:

| 关键字 | 含义 | JS 对照 |
|--------|------|---------|
| `static` | 属于**类本身**而非实例;不用 new 就能用 | `static` 类似,但 Java 用得多 |
| `final` | 变量不可重新赋值 / 方法不可重写 / 类不可继承 | `const`(仅变量层面) |
| `this` | 当前实例 | 同 JS,但**不会有 this 丢失问题**(Java this 不乱跳) |
| `super` | 父类 | `super` |
| `new` | 创建对象实例 | `new` |
| `void` | 方法无返回值 | 无 |
| `abstract` | 抽象(类/方法) | 无 |
| `instanceof` | 判断对象类型 | `instanceof` |
| `null` | 空引用 | `null`(没有 `undefined`) |

### 5.1 🧠 `static` 深入理解(重点)

```java
public class Counter {
    static int total = 0;         // 类变量:所有实例共享一份
    int id;                       // 实例变量:每个对象各一份

    static int getTotal() {       // 静态方法:不依赖实例
        return total;
    }
}

Counter.getTotal();   // 直接用类名调用,不需要 new
```

> 🧠 `static` 的东西**在类加载时就存在,全局唯一**。工具方法(如 `Math.max()`)、常量常用 static。**静态方法里不能用 `this`**(它不属于任何实例)。

### 5.2 📌 main 方法(程序入口,背下来)

```java
public static void main(String[] args) {
    // 程序从这里开始跑
}
```
> 📌 这个签名**一字不差要背住**:`public static void main(String[] args)`。它是 Java 程序的启动入口。

---

## 6. 🧠 内存模型:栈、堆、垃圾回收

JS 你几乎不用管内存;Java 里理解内存模型能帮你搞懂"引用""NPE""值传递"。

```
┌─────────────┐        ┌──────────────────┐
│    栈 Stack  │        │      堆 Heap      │
│ (每个线程一个)│        │  (所有线程共享)   │
├─────────────┤        ├──────────────────┤
│ 基本类型的值 │        │  所有 new 出来的  │
│ int a = 5   │        │  对象实例         │
│ 对象的引用   │───────▶│  User{name:"Tom"}│
│ User u ─────┼───────▶│  int[]{1,2,3}    │
└─────────────┘        └──────────────────┘
                              ▲
                         GC 垃圾回收器自动清理
                         没有任何引用指向的对象
```

**🧠 关键理解:**
- **基本类型**存在栈里(值本身);**对象**存在堆里,变量存的是指向它的**引用**。
- **GC(垃圾回收)**:没有引用指向的对象会被自动回收。你不用手动 free,但要理解"内存泄漏 = 该释放的对象还被某处引用着"。
- **Java 全是值传递**:传对象时,传的是"引用的拷贝"(所以能改对象内部,但重新赋值不影响原变量)。这点和 JS 一致,理解了栈堆就懂了。

```java
void change(User u) {
    u.setName("Bob");     // ✅ 改的是堆里同一个对象,外部能看到
    u = new User("X", 0); // ❌ 只改了局部引用,外部原变量不受影响
}
```

---

## 7. 🧠📌 集合框架(Collections)—— 天天用,要会选型

Java 没有 JS 那种万能的 Array/Object,而是一整套集合类。**要记住选型,要懂底层。**

### 7.1 🌉 三大接口

| 接口 | 是什么 | JS 对照 | 特点 |
|------|--------|---------|------|
| `List` | 有序、可重复 | Array | 按索引访问 |
| `Set` | 无序、**不重复** | Set | 自动去重 |
| `Map` | 键值对 | Map / Object | key-value |

### 7.2 📌 常用实现类(要背选型)

| 接口 | 常用实现 | 底层 | 什么时候用 |
|------|----------|------|-----------|
| List | **`ArrayList`** | 动态数组 | **默认选它**,随机访问快 |
| List | `LinkedList` | 链表 | 频繁在头尾增删 |
| Set | **`HashSet`** | 哈希表 | 默认,去重、查得快 |
| Set | `TreeSet` | 红黑树 | 需要**自动排序** |
| Set | `LinkedHashSet` | 哈希+链表 | 去重且**保持插入顺序** |
| Map | **`HashMap`** | 哈希表 | **默认选它** |
| Map | `TreeMap` | 红黑树 | key 需要排序 |
| Map | `LinkedHashMap` | 哈希+链表 | 保持插入顺序 |

```java
List<String> list = new ArrayList<>();   // <String> 是泛型,限定元素类型
list.add("a");
list.add("b");
list.get(0);              // "a"
list.size();

Map<String, Integer> map = new HashMap<>();
map.put("age", 18);
map.get("age");           // 18
map.getOrDefault("x", 0); // key 不存在返回默认值,防 NPE

Set<Integer> set = new HashSet<>();
set.add(1); set.add(1);   // 只会存一个 1
```

> 🧠 **`<String>` 是泛型**(下一节),声明这个 List 只能放 String,编译器帮你检查。JS 里数组啥都能放,Java 里限定类型。

> 📌 **快速创建不可变集合**(Java 9+,很常用):
> ```java
> List<String> names = List.of("a", "b", "c");
> Map<String, Integer> m = Map.of("x", 1, "y", 2);
> ```

---

## 8. 🧠 泛型(Generics)—— 理解"类型参数化"

泛型让你写"能处理多种类型但仍类型安全"的代码。JS 没有(TS 才有,你若接触过 TS 泛型会很快)。

```java
// 没泛型:啥都能放,取出来要强转,容易出错
List list = new ArrayList();
list.add("hi");
String s = (String) list.get(0);   // 必须强制转换,还可能转错

// 有泛型:声明只放 String,取出即是 String
List<String> list2 = new ArrayList<>();
list2.add("hi");
String s2 = list2.get(0);          // 无需转换,类型安全
```

自定义泛型:
```java
public class Box<T> {              // T 是类型占位符
    private T value;
    public void set(T value) { this.value = value; }
    public T get() { return value; }
}

Box<String> b = new Box<>();       // T 被指定为 String
```

> 🧠 **类型擦除(Type Erasure)—— 必懂的原理**:泛型只在**编译期**检查,运行时类型信息被"擦除"。所以:
> ```java
> new ArrayList<String>().getClass() == new ArrayList<Integer>().getClass()  // true!
> ```
> 运行时它们都只是 `ArrayList`。这解释了很多"为什么泛型不能这样用"的限制(如不能 `new T()`)。

---

## 9. 🧠📌 异常处理:checked vs unchecked

JS 只有一种 `try/catch`。Java 分两类异常,这是重大差异。

```java
try {
    int r = 5 / 0;                    // 抛 ArithmeticException
} catch (ArithmeticException e) {
    System.out.println("除零错误: " + e.getMessage());
} finally {
    System.out.println("总会执行");   // 类似 JS 的 finally
}
```

### 9.1 🧠 两类异常(核心区别)

| 类型 | 例子 | 编译器强制处理? | 何时发生 |
|------|------|:---:|---------|
| **Checked(受检)** | `IOException`, `SQLException` | ✅ **必须** try-catch 或 throws 声明 | 外部原因(文件、网络、DB) |
| **Unchecked(非受检/运行时)** | `NullPointerException`, `ArrayIndexOutOfBounds` | ❌ 不强制 | 程序 bug |

```java
// Checked 异常:编译器逼你处理,否则编译不过
public void readFile() throws IOException {   // 要么 throws 往上抛
    Files.readString(Path.of("a.txt"));
}
// 或者 try-catch 就地处理
```

> 🧠 **NullPointerException(NPE)是你未来最常遇到的异常**——对 `null` 调方法/取字段就崩。它是 unchecked,编译器不拦,所以要**主动防范**(见第 12 节 Optional)。

> 📌 **异常继承层次**(了解即可):`Throwable` → `Exception`(可处理) / `Error`(严重,如内存溢出,别 catch)。`RuntimeException` 是 unchecked 的基类。

---

## 10. 🌉 函数式:Lambda 与 Stream(你会觉得亲切)

这部分和你熟悉的 JS 数组方法几乎一一对应,是转 Java 最"顺"的部分。

### 10.1 🌉 Lambda(≈ 箭头函数)

```js
// JS
const add = (a, b) => a + b;
arr.forEach(x => console.log(x));
```
```java
// Java
list.forEach(x -> System.out.println(x));

// 函数式接口 + lambda
Comparator<Integer> cmp = (a, b) -> a - b;

// 方法引用(更简洁),等价于 x -> System.out.println(x)
list.forEach(System.out::println);
```

### 10.2 🌉 Stream(≈ 数组的 map/filter/reduce 链)

```js
// JS
const result = users
  .filter(u => u.age >= 18)
  .map(u => u.name)
  .slice(0, 10);
```
```java
// Java
List<String> result = users.stream()
    .filter(u -> u.getAge() >= 18)     // 过滤
    .map(User::getName)                // 映射
    .limit(10)                         // 取前 10
    .collect(Collectors.toList());     // 收尾:转回 List(必须有这步)
```

**🌉 对照表:**

| JS 数组方法 | Java Stream |
|------------|-------------|
| `.filter()` | `.filter()` |
| `.map()` | `.map()` |
| `.reduce()` | `.reduce()` |
| `.forEach()` | `.forEach()` |
| `.find()` | `.findFirst()` |
| `.some()` / `.every()` | `.anyMatch()` / `.allMatch()` |
| `.sort()` | `.sorted()` |
| `.slice(0,n)` | `.limit(n)` |
| (末尾拿结果) | **`.collect()`** ← 必须收尾 |

> 🧠 **Stream 是惰性的(lazy)**:中间操作(filter/map)不会立即执行,直到遇到**终止操作**(collect/forEach/count)才一次性跑完。没有终止操作,整条链什么都不做。这和 JS 立即执行不同。

---

## 11. 🧠 并发与多线程(Java 与 JS 最大的世界观差异)

> ⚠️ 这是你作为 JS 开发者**最陌生、最重要**的一章。JS 是单线程,你从没真正处理过"两段代码同时改一个变量"。Java 是真多线程。

### 11.1 🧠 核心差异

- **JS**:单线程 + 事件循环,异步用 Promise/async,**永远只有一个线程在跑你的代码**,不存在"同时修改"。
- **Java**:可以开多个线程**真正并行**执行,多个线程可能**同时读写同一份数据** → 产生**竞态条件(race condition)**。

```java
// 起一个线程
Thread t = new Thread(() -> {
    System.out.println("在新线程里跑");
});
t.start();
```

### 11.2 🧠 线程安全问题(必须理解)

```java
int count = 0;
// 假设 1000 个线程同时执行 count++
count++;   // 这不是原子操作!实际是:读 count → 加 1 → 写回
           // 多线程交错执行会丢失更新,最终结果 < 1000
```

**🧠 解决手段(知道有这些即可,用时深入):**

| 工具 | 作用 |
|------|------|
| `synchronized` | 加锁,保证同一时刻只有一个线程进入 |
| `volatile` | 保证变量的可见性(一个线程改了,其他线程立刻看到) |
| `AtomicInteger` 等 | 原子操作类,`count++` 变安全 |
| `ConcurrentHashMap` | 线程安全的 Map(多线程别用普通 HashMap) |
| 线程池 `ExecutorService` | 复用线程,别手动 new 一堆 Thread |

### 11.3 🌉 异步的对照

| JS | Java |
|----|------|
| `Promise` | `CompletableFuture` |
| `async/await` | `CompletableFuture` 链式 / 虚拟线程 |
| `Promise.all([...])` | `CompletableFuture.allOf(...)` |
| 事件循环 | 线程 + 线程池 |

> 🧠 **你要记住的判断力**:AI 写的多线程代码,你要能看出"这个共享变量有没有加锁""这个 Map 该不该用 Concurrent 版本"。**并发 bug 极难复现、极难调试,这是原理必须懂透的部分。** 新手阶段:能不共享可变状态就不共享。

> 📌 **Java 21 虚拟线程(Virtual Threads)**:新特性,让写并发像写同步代码一样简单、又能扛高并发,值得关注。

---

## 12. 📌 现代 Java 特性(让代码接近现代 JS 的简洁)

学新版本(17/21)一定要用这些,别写老古董代码。

### 12.1 `record`(≈ 简洁的数据类,自动生成一切)

```java
// 老写法:一个数据类要写几十行(字段+构造器+getter+equals+hashCode+toString)
// record 一行搞定:
public record User(String name, int age) {}

User u = new User("Tom", 18);
u.name();          // 自动生成访问器
u.equals(other);   // 自动按内容比较
u.toString();      // 自动 "User[name=Tom, age=18]"
```
> 🌉 类似 JS 里一个纯数据对象 `{name, age}`,但类型安全、不可变。**DTO / 值对象首选 record。**

### 12.2 `Optional`(优雅处理 null,防 NPE)

```java
Optional<User> found = repository.findById(1);   // 可能有也可能没有
String name = found
    .map(User::getName)
    .orElse("默认名");         // 没有就给默认值
```
> 🧠 用 Optional 表达"这个值可能不存在",强迫调用方处理空情况,比到处 `if (x != null)` 更清晰。**别对 Optional 再 `.get()` 不判断,那等于没用。**

### 12.3 switch 表达式 & 模式匹配(Java 14+)

```java
// 新 switch:是表达式,能返回值,不用写 break
String desc = switch (day) {
    case MON, TUE, WED, THU, FRI -> "工作日";
    case SAT, SUN -> "周末";
};
```

### 12.4 文本块(Text Block,≈ 模板字符串的多行版)

```java
String json = """
    {
        "name": "Tom",
        "age": 18
    }
    """;
```

### 12.5 字符串格式化(≈ 模板字符串)

```js
`Hello ${name}, age ${age}`               // JS
```
```java
String.format("Hello %s, age %d", name, age);   // Java(%s 字符串, %d 整数)
// 或 Java 15+: "Hello %s".formatted(name)
```

---

## 13. 📌 构建工具与生态(工程化认知)

| JS 世界 | Java 世界 | 说明 |
|---------|-----------|------|
| npm / yarn / pnpm | **Maven** 或 **Gradle** | 依赖管理 + 构建工具 |
| `package.json` | `pom.xml`(Maven) / `build.gradle`(Gradle) | 项目/依赖配置 |
| `node_modules` | 本地仓库 `~/.m2/`(Maven) | 依赖存放处 |
| npm registry | Maven Central | 中央仓库 |
| `import { x } from './y'` | `import com.foo.Bar;` | 导入 |
| 模块/文件 | **包(package)** | 用域名倒序,如 `com.company.project` |

**📌 一个依赖的坐标(Maven)长这样(GAV):**
```xml
<dependency>
    <groupId>com.google.code.gson</groupId>     <!-- 组织 -->
    <artifactId>gson</artifactId>               <!-- 包名 -->
    <version>2.10.1</version>                   <!-- 版本 -->
</dependency>
```

> 📌 **package 与目录对应**:`package com.foo.bar;` 的文件必须放在 `com/foo/bar/` 目录下。这是强制约定。

> 🌉 **classpath** ≈ Node 的模块解析路径:JVM 去哪找类。出 `ClassNotFoundException` 通常是 classpath / 依赖没配好。

---

## 14. 🌉 Spring 生态(做后端几乎必学,先建立概念)

如果你转 Java 是为了写后端服务,90% 会用 **Spring Boot**。先知道它是什么:

- **Spring Boot**:快速搭建 Java 后端服务的框架(≈ JS 里的 NestJS,概念很像)。
- **核心思想:依赖注入(DI)/ 控制反转(IoC)** 🧠:你不自己 `new` 对象,而是"声明我需要什么",框架自动帮你创建并"注入"进来。

```java
@RestController                       // 声明这是个 Web 接口控制器
public class UserController {

    @Autowired                        // 依赖注入:框架自动塞进来,不用手动 new
    private UserService userService;

    @GetMapping("/users/{id}")        // 路由:GET /users/1
    public User getUser(@PathVariable int id) {
        return userService.findById(id);
    }
}
```

> 🌉 如果你用过 NestJS,`@RestController`/`@GetMapping`/`@Autowired` 这套装饰器风格会非常眼熟。**注解(Annotation,`@` 开头)是 Spring 的灵魂**,先理解"注解是给框架看的标记"。

> 🧠 **依赖注入的价值**:解耦、易测试。这是 Java 企业开发的核心思想,值得花时间理解,不是死记。

---

## 15. 🌉 JS → Java 速查表(贴墙用)

| JavaScript | Java | 备注 |
|-----------|------|------|
| `let x = 1` | `int x = 1;` / `var x = 1;` | 类型静态 |
| `const X = 1` | `final int X = 1;` | |
| `Array` | `List<T>` / `T[]` | 优先 ArrayList |
| `Object` / `Map` | `Map<K,V>` / 类 / record | |
| `null` / `undefined` | `null`(只有一种) | |
| `===` | `==`(基本类型)/ `.equals()`(对象) | **别用 == 比对象** |
| `typeof x` | `x instanceof Type` / `x.getClass()` | |
| `x => x + 1` | `x -> x + 1` | lambda |
| `.map/.filter/.reduce` | `.stream().map/filter/reduce` | 记得 `.collect()` 收尾 |
| `Promise` | `CompletableFuture` | |
| `async/await` | 线程 / CompletableFuture / 虚拟线程 | |
| `JSON.parse/stringify` | Jackson / Gson 库 | 非内置 |
| `console.log(x)` | `System.out.println(x);` | |
| `` `Hi ${n}` `` | `String.format("Hi %s", n)` / 文本块 | |
| `throw new Error()` | `throw new RuntimeException();` | |
| `import ... from` | `import ...;` | |
| npm | Maven / Gradle | |
| `package.json` | `pom.xml` / `build.gradle` | |
| NestJS | Spring Boot | 后端框架 |
| `{a, b} = obj`(解构) | record 模式匹配(21+) | Java 解构弱 |
| `...spread` | 可变参数 `String... args` | |

---

## 16. ✅ 学习优先级 & AI 协作建议

### 16.1 建议学习顺序

1. **基础语法 + 类型系统**(第 2、3 节)—— 打通"静态类型 + == 坑"
2. **面向对象**(第 4、5 节)—— Java 的骨架
3. **集合 + 泛型 + Stream**(第 7、8、10 节)—— 日常写代码主力
4. **异常 + 现代特性**(第 9、12 节)—— 写出地道代码
5. **内存模型 + 并发**(第 6、11 节)—— 进阶,决定你能否调难 bug
6. **构建 + Spring**(第 13、14 节)—— 工程化落地

### 16.2 🧠 在 AI 时代,你的精力该放哪

**可以少背、交给 AI 的**(能看懂就行):
- 具体 API 方法名、参数顺序
- 样板代码(getter/setter、try-catch 结构、Maven 配置)
- 各种库的用法(Jackson、Lombok 等)

**必须自己懂透的**(AI 替不了你的判断):
- `==` vs `equals`、装箱拆箱、整数除法这类**"坑"**(AI 也会写错,你得能发现)
- **NPE 的成因与防范**(你未来 debug 最多的东西)
- **并发/线程安全**(AI 生成的并发代码,对错要你判断)
- **集合选型**(该用 HashMap 还是 TreeMap,该不该用 Concurrent 版本)
- **静态类型 + 泛型**的思维(读懂类型报错)
- **内存模型**(值传递、引用、GC —— 理解程序为什么这样跑)

> 🎯 **一句话总结**:在 AI 帮你写 Java 的时代,你要成为那个**"能一眼看出这段代码有 NPE 风险 / 有线程安全问题 / 集合选错了"** 的人。语法是术,这些判断力是道。

---

## 📌 附:最容易踩的 10 个坑(JS 老手速记)

1. `==` 比对象比的是引用,**内容比较用 `.equals()`**
2. `5 / 2 == 2`(整数除法截断)
3. 拆箱 `null` 的 `Integer` → **NPE**
4. `Integer` 有 -128~127 缓存,`==` 时会误导
5. 数组长度固定,动态用 `ArrayList`
6. `if (x)` 里 x 必须是 boolean,**没有 truthy/falsy**
7. 字符串不可变,大量拼接用 `StringBuilder`
8. Checked 异常**必须**处理,否则编译不过
9. Stream 不 `.collect()`/终止操作就**什么都不执行**
10. 多线程共享可变状态不加锁 → 隐蔽的并发 bug

---

*本文档为个人学习笔记,持续复习补充。有新坑随时往第 16/附录里加。*
