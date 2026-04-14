#pragma once

#include <string>
#include <utility>

template <typename T>
struct Result
{
    bool success = false;
    int error_code = 0;
    T value{};
    std::string message;

    static Result ok(T value)
    {
        Result r;
        r.success = true;
        r.value = std::move(value);
        return r;
    }

    static Result fail(int error_code, std::string message)
    {
        Result r;
        r.success = false;
        r.error_code = error_code;
        r.message = std::move(message);
        return r;
    }
};

template <>
struct Result<void>
{
    bool success = false;
    int error_code = 0;
    std::string message;

    static Result ok()
    {
        Result r;
        r.success = true;
        return r;
    }

    static Result fail(int error_code, std::string message)
    {
        Result r;
        r.success = false;
        r.error_code = error_code;
        r.message = std::move(message);
        return r;
    }
};
