#pragma once

#include <atomic>
#include <functional>
#include <string>

struct RunContext
{
    std::atomic_bool* cancel_flag = nullptr;
    std::function<void(const std::string&, int)> progress;
    std::function<void(const std::string&)> warning;

    bool isCancelled() const
    {
        return cancel_flag && cancel_flag->load();
    }
};
