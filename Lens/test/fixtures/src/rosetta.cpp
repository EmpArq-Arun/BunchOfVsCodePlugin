// Statement-level construct fixture. Every case a C engineer meets in the first
// week of reading modern C++ firmware, exactly once.
#include <cstdint>

namespace fw {

struct Lock {
    explicit Lock(uint32_t mask) : mask_(mask) {}
    ~Lock();
    Lock(const Lock&) = delete;
    uint32_t mask_;
};

struct Buffer {
    Buffer();
    Buffer(const Buffer&);
    Buffer(Buffer&&) noexcept;
    ~Buffer();
    uint8_t* data();
    uint32_t size() const;
    uint8_t& operator[](uint32_t i);
};

struct ISpi {
    virtual bool transfer(uint8_t* p, uint32_t n) = 0;
    virtual ~ISpi();
};

Buffer make_buffer();
void consume(const Buffer&);
bool guarded();
struct Sensor { uint32_t id; float value; };
Sensor read_sensor();

// --- the function under test ---------------------------------------------
uint32_t process(ISpi& spi, Buffer& out) {
    Lock lock(0x20);                       // RAII: ctor here, dtor at scope end
    static uint32_t counter = 0;           // function-local static -> guard variable
    counter++;

    Buffer scratch = make_buffer();        // copy elision / move
    consume(make_buffer());                // temporary destroyed at end of statement

    auto on_done = [&out](uint32_t n) {    // lambda with capture by reference
        (void)out;
        return n * 2u;
    };

    uint8_t* p = scratch.data();
    if (!spi.transfer(p, scratch.size())) { // virtual call through a reference
        throw 1;                            // exception
    }

    out[0] = scratch[0];                    // overloaded operator[] -> function call

    uint8_t stack_array[4] = {1, 2, 3, 4};
    for (uint8_t b : stack_array) {         // range-for
        (void)b;
    }

    auto [id, value] = read_sensor();       // structured bindings
    (void)value;

    Buffer* heap = new Buffer();            // heap allocation
    if (auto* concrete = dynamic_cast<ISpi*>(&spi)) {  // RTTI
        (void)concrete;
    }
    delete heap;                            // and its release

    return on_done(counter) + id;
}

} // namespace fw
