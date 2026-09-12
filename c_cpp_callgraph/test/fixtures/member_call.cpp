class Widget {
public:
    void tick() {}
};

void run() {
    Widget w;
    w.tick();

    Widget* p = &w;
    p->tick();
}
