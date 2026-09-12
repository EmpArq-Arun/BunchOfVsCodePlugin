int helper(int x) {
    return x * 2;
}

int compute(int n) {
    if (n <= 1) return 1;
    int h = helper(n);
    return h + compute(n - 1);
}

class Shape {
public:
    virtual double area() { return 0.0; }
};

class Circle : public Shape {
public:
    double area() override { return helper(3); }
};

typedef int (*Fn)(int);
void dispatch() {
    Fn f = helper;
    f(5);
}

#if 0
void dead_code() { helper(0); }
#endif
