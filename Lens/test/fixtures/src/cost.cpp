// Cost fixture: every ABI artifact a C engineer pays for without seeing it.
#include <cstdint>
#include <new>

namespace fw {

struct ISpi {
    virtual bool transfer(uint8_t* p, uint32_t n) = 0;
    virtual ~ISpi() {}
};

struct IUart {
    virtual void write(uint8_t b) = 0;
    virtual ~IUart() {}
};

struct SpiDriver : ISpi {
    bool transfer(uint8_t* p, uint32_t n) override { return p != nullptr && n > 0; }
    uint32_t calls_ = 0;
};

// Two vptrs and a this-adjusting thunk.
struct DuplexPort : ISpi, IUart {
    bool transfer(uint8_t* p, uint32_t n) override { return n < 64 && p != nullptr; }
    void write(uint8_t b) override { last_ = b; }
    uint8_t last_ = 0;
};

// Virtual base: emits a VTT and construction vtables.
struct Left : virtual ISpi { uint8_t l_ = 1; };
struct Right : virtual ISpi { uint8_t r_ = 2; };
struct Diamond : Left, Right {
    bool transfer(uint8_t*, uint32_t) override { return true; }
    uint8_t d_ = 3;
};

// Global object with a constructor: an .init_array entry.
struct Registry {
    Registry();
    ~Registry();
    uint32_t n_;
};
Registry::Registry() : n_(0) {}
Registry::~Registry() {}
Registry g_registry;

// Function-local static: guard variable.
uint32_t seed();
uint32_t& counter() {
    // Runtime-initialised, so this one needs a guard variable. A constant
    // initialiser would not — worth knowing before optimising the wrong thing.
    static uint32_t value = seed();
    return value;
}
uint32_t seed() { return 7; }

// RTTI and exceptions.
bool is_uart(ISpi* p) {
    if (dynamic_cast<IUart*>(p)) { return true; }
    return false;
}

uint32_t risky(uint32_t n) {
    if (n == 0) { throw 42; }
    return n * 2;
}

// A template instantiated three ways.
template <typename T> struct Ring {
    T slots[8];
    T pop() { return slots[--head_]; }
    uint32_t head_ = 0;
};
template struct Ring<uint8_t>;
template struct Ring<uint16_t>;
template struct Ring<uint32_t>;

} // namespace fw

int main(int argc, char**) {
    fw::SpiDriver spi;
    fw::DuplexPort duplex;
    fw::Diamond diamond;
    fw::ISpi* ps[3] = { &spi, &duplex, &diamond };
    fw::ISpi* p = ps[argc % 3];
    uint8_t buf[4] = {};
    volatile bool ok = p->transfer(buf, 4) && fw::is_uart(&duplex);
    fw::counter()++;
    try { (void)fw::risky(0); } catch (int) { }
    fw::Ring<uint8_t> r8; fw::Ring<uint16_t> r16; fw::Ring<uint32_t> r32;
    volatile auto s = r8.head_ + r16.head_ + r32.head_ + duplex.last_ + diamond.d_ + spi.calls_;
    (void)s; (void)ok;
    return 0;
}
