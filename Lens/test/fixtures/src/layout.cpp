// Layout fixture: every way a C mental model of struct size goes wrong in C++.
#include <cstdint>

namespace fw {

// Padding a C engineer would predict correctly.
struct PinConfig {
    uint8_t  port;
    uint32_t mask;      // 3 bytes of padding before this
    uint8_t  pin;
};                      // 3 bytes of tail padding

// Bitfields: familiar from register maps.
struct StatusReg {
    uint32_t ready : 1;
    uint32_t error : 1;
    uint32_t count : 6;
    uint32_t       : 8;   // unnamed padding bits
    uint32_t code  : 16;
};

union RegisterView {
    uint32_t raw;
    StatusReg bits;
};

// A vptr appears where nothing in the source says so.
struct ISpi {
    virtual bool transfer(uint8_t* p, uint32_t n) = 0;
    virtual ~ISpi();
};

struct IUart {
    virtual void write(uint8_t b) = 0;
    virtual ~IUart();
};

struct SpiDriver : ISpi {
    bool transfer(uint8_t* p, uint32_t n) override;
    uint8_t  channel_;
    uint32_t volatile* base_;
};

// Two vptrs, and a this-adjustment on cast.
struct DuplexPort : ISpi, IUart {
    bool transfer(uint8_t* p, uint32_t n) override;
    void write(uint8_t b) override;
    uint16_t depth_;
};

// Virtual bases: offsets that are not compile-time constants.
struct Left : virtual ISpi { uint8_t l_; };
struct Right : virtual ISpi { uint8_t r_; };
struct Diamond : Left, Right {
    bool transfer(uint8_t* p, uint32_t n) override;
    uint8_t d_;
};

// Empty base optimisation: a base that costs nothing.
struct Tag {};
struct Tagged : Tag { uint32_t value_; };

// Same members, better order.
struct Wasteful { uint8_t a; uint64_t b; uint8_t c; uint64_t d; };
struct Tight    { uint64_t b; uint64_t d; uint8_t a; uint8_t c; };

}

// Force emission so DWARF describes every type.
fw::PinConfig    g_pin;
fw::RegisterView g_reg;
fw::SpiDriver    g_spi;
fw::DuplexPort   g_duplex;
fw::Diamond      g_diamond;
fw::Tagged       g_tagged;
fw::Wasteful     g_wasteful;
fw::Tight        g_tight;
