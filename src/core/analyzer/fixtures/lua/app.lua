local function helper()
  return 1
end

local function run()
  return helper()
end

function M.boot()
  return run()
end
