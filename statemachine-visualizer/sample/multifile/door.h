#ifndef DOOR_H
#define DOOR_H
typedef enum { DOOR_CLOSED, DOOR_OPENING, DOOR_OPEN, DOOR_CLOSING, DOOR_ERROR } DoorState;
void Door_Tick(int event);
DoorState Door_GetState(void);
#endif
