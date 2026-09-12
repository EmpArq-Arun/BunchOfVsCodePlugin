/**
  ******************************************************************************
  * @file    stm32g4xx.h
  * @brief   CMSIS STM32G4xx Device Peripheral Access Layer Header File.
  ******************************************************************************
  */
#ifndef __STM32G4xx_H
#define __STM32G4xx_H

#ifdef __cplusplus
 extern "C" {
#endif

#if !defined (STM32G4)
#define STM32G4
#endif

/* Uncomment the line below according to the target STM32G4 device used in your
   application */
#if !defined (STM32G431xx) && !defined (STM32G441xx) && !defined (STM32G471xx) && \
    !defined (STM32G473xx) && !defined (STM32G474xx) && !defined (STM32G483xx) && \
    !defined (STM32G484xx) && !defined (STM32G491xx) && !defined (STM32G4A1xx) && \
    !defined (STM32GBK1CB)
  #error "Please select first the target STM32G4xx device used in your application (in stm32g4xx.h file)"
#endif

#if !defined  (USE_HAL_DRIVER)
/**
 * @brief Comment the line below if you will not use the peripherals drivers.
 */
  /*#define USE_HAL_DRIVER */
#endif

#ifdef __cplusplus
}
#endif
#endif /* __STM32G4xx_H */
