cmake_minimum_required(VERSION 3.22)
project(ledgr_needle_jni)

add_library(needle_jni SHARED needle_jni.cpp)
target_link_options(needle_jni PRIVATE
  "-Wl,-z,max-page-size=16384"
  "-Wl,-z,common-page-size=16384"
)
target_include_directories(needle_jni PRIVATE include)

set(NEEDLE_A "${CMAKE_CURRENT_SOURCE_DIR}/../jniLibsStatic/${ANDROID_ABI}/libneedle.a")
if(NOT EXISTS "${NEEDLE_A}")
  message(FATAL_ERROR "Missing ${NEEDLE_A}. Run frontend/scripts/on-device-ai/fetch-native.mjs")
endif()

add_library(needle STATIC IMPORTED)
set_target_properties(needle PROPERTIES IMPORTED_LOCATION "${NEEDLE_A}")
find_library(log-lib log)
target_link_libraries(needle_jni needle ${log-lib})
