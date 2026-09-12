#include "door_hw.h"
#include "timer.h"

typedef enum {
    DOOR_CLOSED,
    DOOR_OPENING,
    DOOR_OPEN,
    DOOR_CLOSING,
    DOOR_ERROR
} DoorState;

static DoorState currentState = DOOR_CLOSED;
extern volatile uint8_t g_obstacleDetected;

void Door_RegisterCallback(void (*cb)(void)) {
    onDoorEvent = cb;
}

void Door_Tick(Event_t event) {
    switch (currentState) {
        case DOOR_CLOSED:
            if (event == EVENT_OPEN_REQUEST) {
                StartMotor(MOTOR_FORWARD);
                currentState = DOOR_OPENING;
            }
            break;

        case DOOR_OPENING:
            if (g_obstacleDetected) {
                StopMotor();
                currentState = DOOR_ERROR;
            } else if (event == EVENT_LIMIT_REACHED) {
                StopMotor();
                currentState = DOOR_OPEN;
            }
            break;

        case DOOR_OPEN:
            if (event == EVENT_CLOSE_REQUEST) {
                StartMotor(MOTOR_REVERSE);
                currentState = DOOR_CLOSING;
            }
            break;

        case DOOR_CLOSING:
            if (g_obstacleDetected) {
                StopMotor();
                currentState = DOOR_OPENING;
            } else if (event == EVENT_LIMIT_REACHED) {
                StopMotor();
                currentState = DOOR_CLOSED;
            }
            break;

        case DOOR_ERROR:
            if (event == EVENT_RESET) {
                currentState = DOOR_CLOSED;
            }
            break;

        default:
            break;
    }
}

DoorState Door_GetState(void) {
    return currentState;
}
