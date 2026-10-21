// Node-API only: no arbitrary Win32 symbols, pointers or caller-supplied SIDs.
#include <node_api.h>
#include <string>
#include <vector>
#include <stdexcept>
#include <cstdint>
#include <cstring>
#include <cstddef>
#include <limits>
#include <memory>
#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <bcrypt.h>
#include <algorithm>

namespace {
struct Failure { const char* reason; };
[[noreturn]] void reject(const char* reason) { throw Failure{reason}; }
struct Handle {
  HANDLE value=INVALID_HANDLE_VALUE;
  Handle()=default; explicit Handle(HANDLE h):value(h){}
  Handle(const Handle&)=delete; Handle& operator=(const Handle&)=delete;
  Handle(Handle&& other) noexcept:value(other.value){other.value=INVALID_HANDLE_VALUE;}
  Handle& operator=(Handle&& other) noexcept {if(this!=&other){if(value!=INVALID_HANDLE_VALUE)CloseHandle(value);value=other.value;other.value=INVALID_HANDLE_VALUE;}return *this;}
  ~Handle(){if(value!=INVALID_HANDLE_VALUE)CloseHandle(value);}
};
struct LocalMemory { void* value=nullptr; ~LocalMemory(){if(value)LocalFree(value);} };
void check(bool ok,const char* reason="IO_ERROR"){if(!ok)reject(reason);}
std::wstring text(napi_env env,napi_value value){
  napi_valuetype type;check(napi_typeof(env,value,&type)==napi_ok&&type==napi_string,"INVALID_PATH");
  size_t size=0;check(napi_get_value_string_utf16(env,value,nullptr,0,&size)==napi_ok&&size>0&&size<32760,"INVALID_PATH");
  std::vector<char16_t> buffer(size+1);check(napi_get_value_string_utf16(env,value,buffer.data(),buffer.size(),&size)==napi_ok,"INVALID_PATH");
  return std::wstring(reinterpret_cast<wchar_t*>(buffer.data()),size);
}
bool has(napi_env env,napi_value object,const char* key){bool value=false;check(napi_has_own_property(env,object,[&]{napi_value name;napi_create_string_utf8(env,key,NAPI_AUTO_LENGTH,&name);return name;}(),&value)==napi_ok);return value;}
napi_value property(napi_env env,napi_value object,const char* key){napi_value value;check(napi_get_named_property(env,object,key,&value)==napi_ok);return value;}
bool boolean(napi_env env,napi_value object,const char* key,bool fallback=false){if(!has(env,object,key))return fallback;auto value=property(env,object,key);napi_valuetype type;check(napi_typeof(env,value,&type)==napi_ok);if(type==napi_undefined)return fallback;bool result;check(napi_get_value_bool(env,value,&result)==napi_ok);return result;}
uint64_t maximum(napi_env env,napi_value object){if(!has(env,object,"maxBytes"))return std::numeric_limits<uint64_t>::max();auto value=property(env,object,"maxBytes");napi_valuetype type;check(napi_typeof(env,value,&type)==napi_ok);if(type==napi_undefined)return std::numeric_limits<uint64_t>::max();double result;check(napi_get_value_double(env,property(env,object,"maxBytes"),&result)==napi_ok&&result>=0&&result<=8ULL*1024*1024*1024&&result==static_cast<uint64_t>(result),"SIZE_LIMIT");return static_cast<uint64_t>(result);}
napi_value undefined(napi_env env){napi_value value;napi_get_undefined(env,&value);return value;}
napi_value nullValue(napi_env env){napi_value value;napi_get_null(env,&value);return value;}
void set(napi_env env,napi_value object,const char* name,napi_value value){check(napi_set_named_property(env,object,name,value)==napi_ok);}
napi_value stringValue(napi_env env,const std::string& text){napi_value value;check(napi_create_string_utf8(env,text.data(),text.size(),&value)==napi_ok);return value;}
bool equal(const std::wstring& a,const std::wstring& b){return CompareStringOrdinal(a.c_str(),static_cast<int>(a.size()),b.c_str(),static_cast<int>(b.size()),TRUE)==CSTR_EQUAL;}
std::wstring upper(std::wstring value){for(auto& c:value)if(c>=L'a'&&c<=L'z')c-=L'a'-L'A';return value;}
struct Path {std::wstring value;std::vector<std::wstring> components;};
Path canonical(std::wstring value){
  check(value.size()>=3&&value[0]>=L'A'&&value[0]<=L'Z'&&value[1]==L':'&&value[2]==L'\\',"INVALID_PATH");
  check(value.size()==3||value.back()!=L'\\',"UNSAFE_ALIAS");
  Path path{value,{}};size_t start=3;
  while(start<value.size()){
    size_t end=value.find(L'\\',start);if(end==std::wstring::npos)end=value.size();auto component=value.substr(start,end-start);
    check(!component.empty()&&component!=L"."&&component!=L".."&&component.back()!=L'.'&&component.back()!=L' ',"UNSAFE_ALIAS");
    for(wchar_t c:component)check(c>=32&&std::wstring(L"/:*?\"<>|").find(c)==std::wstring::npos,"INVALID_PATH");
    auto base=upper(component.substr(0,component.find(L'.')));
    check(base!=L"CON"&&base!=L"CONIN$"&&base!=L"CONOUT$"&&base!=L"PRN"&&base!=L"AUX"&&base!=L"NUL"&&base!=L"CLOCK$"&&!(base.size()==4&&(base.substr(0,3)==L"COM"||base.substr(0,3)==L"LPT")&&((base[3]>=L'0'&&base[3]<=L'9')||base[3]==L'\u00b9'||base[3]==L'\u00b2'||base[3]==L'\u00b3')),"UNSAFE_ALIAS");
    path.components.push_back(component);start=end+1;
  }
  check(GetDriveTypeW(value.substr(0,3).c_str())==DRIVE_FIXED,"UNSUPPORTED_FILESYSTEM");return path;
}
std::wstring joinPrefix(const Path& path,size_t count){std::wstring result=path.value.substr(0,3);for(size_t i=0;i<count;i++){if(i)result+=L'\\';result+=path.components[i];}return result;}
struct User {
  Handle token,impersonation;std::vector<BYTE> user;BYTE system[SECURITY_MAX_SID_SIZE],admins[SECURITY_MAX_SID_SIZE];DWORD systemSize=sizeof(system),adminSize=sizeof(admins);std::vector<BYTE> installer;
  User(){
    HANDLE raw;check(OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY|TOKEN_DUPLICATE,&raw));token=Handle(raw);DWORD bytes=0;GetTokenInformation(raw,TokenUser,nullptr,0,&bytes);check(bytes>0);user.resize(bytes);check(GetTokenInformation(raw,TokenUser,user.data(),bytes,&bytes));
    check(CreateWellKnownSid(WinLocalSystemSid,nullptr,system,&systemSize));check(CreateWellKnownSid(WinBuiltinAdministratorsSid,nullptr,admins,&adminSize));
    HANDLE copy;check(DuplicateToken(raw,SecurityImpersonation,&copy));impersonation=Handle(copy);
    DWORD sidSize=0,domainSize=0;SID_NAME_USE use;LookupAccountNameW(nullptr,L"NT SERVICE\\TrustedInstaller",nullptr,&sidSize,nullptr,&domainSize,&use);
    if(sidSize&&domainSize){installer.resize(sidSize);std::vector<wchar_t> domain(domainSize);if(!LookupAccountNameW(nullptr,L"NT SERVICE\\TrustedInstaller",installer.data(),&sidSize,domain.data(),&domainSize,&use))installer.clear();}
  }
  PSID sid()const{return reinterpret_cast<const TOKEN_USER*>(user.data())->User.Sid;}
  bool privileged(PSID value)const{return EqualSid(value,sid())||EqualSid(value,const_cast<BYTE*>(system))||EqualSid(value,const_cast<BYTE*>(admins))||(!installer.empty()&&EqualSid(value,const_cast<BYTE*>(installer.data())));}
};
struct Security {
  LocalMemory memory;SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES),nullptr,FALSE};
  explicit Security(const User& user){LPWSTR raw=nullptr;check(ConvertSidToStringSidW(user.sid(),&raw));LocalMemory sidString;sidString.value=raw;std::wstring sid=raw,sddl=L"O:"+sid+L"D:P(A;OICI;FA;;;"+sid+L")(A;OICI;FA;;;SY)";PSECURITY_DESCRIPTOR descriptor=nullptr;check(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(),SDDL_REVISION_1,&descriptor,nullptr));memory.value=descriptor;attributes.lpSecurityDescriptor=descriptor;}
};
void acl(HANDLE handle,const User& user,bool privateObject,bool protectedRoot){
  PSECURITY_DESCRIPTOR raw=nullptr;PSID owner=nullptr;PACL dacl=nullptr;
  check(GetSecurityInfo(handle,SE_FILE_OBJECT,OWNER_SECURITY_INFORMATION|GROUP_SECURITY_INFORMATION|DACL_SECURITY_INFORMATION,&owner,nullptr,&dacl,nullptr,&raw)==ERROR_SUCCESS,"UNSAFE_ACL");LocalMemory descriptor;descriptor.value=raw;
  check(owner&&IsValidSid(owner)&&(privateObject?EqualSid(owner,user.sid()):user.privileged(owner)),"FOREIGN_OWNER");
  check(dacl&&IsValidAcl(dacl),"UNSAFE_ACL");SECURITY_DESCRIPTOR_CONTROL control;DWORD revision;check(GetSecurityDescriptorControl(raw,&control,&revision),"UNSAFE_ACL");if(protectedRoot)check((control&SE_DACL_PROTECTED)!=0,"UNSAFE_ACL");
  for(DWORD index=0;index<dacl->AceCount;index++){
    void* rawAce=nullptr;check(GetAce(dacl,index,&rawAce),"UNSAFE_ACL");auto header=static_cast<ACE_HEADER*>(rawAce);
    check(header->AceType==ACCESS_ALLOWED_ACE_TYPE||header->AceType==ACCESS_DENIED_ACE_TYPE,"UNSAFE_ACL");
    check(header->AceSize>=offsetof(ACCESS_ALLOWED_ACE,SidStart)+8,"UNSAFE_ACL");
    auto ace=static_cast<ACCESS_ALLOWED_ACE*>(rawAce);PSID principal=&ace->SidStart;
    auto sidBytes=reinterpret_cast<const BYTE*>(principal);
    const size_t availableSidBytes=header->AceSize - offsetof(ACCESS_ALLOWED_ACE,SidStart);
    check(8+4*static_cast<size_t>(sidBytes[1])<=availableSidBytes&&IsValidSid(principal),"UNSAFE_ACL");
    if(header->AceType==ACCESS_DENIED_ACE_TYPE)continue;
    if(privateObject){check(EqualSid(principal,user.sid())||EqualSid(principal,const_cast<BYTE*>(user.system)),"UNSAFE_ACL");}
    else if(!(header->AceFlags&INHERIT_ONLY_ACE)&&!user.privileged(principal)){
      DWORD mask=ace->Mask;GENERIC_MAPPING mapping{FILE_GENERIC_READ,FILE_GENERIC_WRITE,FILE_GENERIC_EXECUTE,FILE_ALL_ACCESS};MapGenericMask(&mask,&mapping);
      check(!(mask&(WRITE_DAC|WRITE_OWNER|DELETE|FILE_DELETE_CHILD)),"UNSAFE_ACL");
    }
  }
  GENERIC_MAPPING mapping{FILE_GENERIC_READ,FILE_GENERIC_WRITE,FILE_GENERIC_EXECUTE,FILE_ALL_ACCESS};DWORD granted=0,bytes=sizeof(PRIVILEGE_SET)+1024;std::vector<BYTE> privileges(bytes);BOOL allowed=FALSE;
  check(AccessCheck(raw,user.impersonation.value,FILE_READ_ATTRIBUTES|READ_CONTROL,&mapping,reinterpret_cast<PRIVILEGE_SET*>(privileges.data()),&bytes,&granted,&allowed)&&allowed,"UNSAFE_ACL");
}
std::string hex(const BYTE* bytes,size_t length){static const char* digits="0123456789abcdef";std::string result;for(size_t i=0;i<length;i++){result+=digits[bytes[i]>>4];result+=digits[bytes[i]&15];}return result;}
struct Identity {std::string volume,fileId;};
Identity identify(HANDLE handle){FILE_ID_INFO info{};check(GetFileInformationByHandleEx(handle,FileIdInfo,&info,sizeof(info)),"IO_ERROR");BYTE volume[8];for(int i=0;i<8;i++)volume[i]=static_cast<BYTE>(info.VolumeSerialNumber>>(56-i*8));return {hex(volume,8),hex(info.FileId.Identifier,16)};}
void validate(HANDLE handle,const std::wstring& expected,const User& user,bool directory,bool privateObject,bool protectedRoot,uint64_t maxBytes){
  FILE_ATTRIBUTE_TAG_INFO attributes{};FILE_STANDARD_INFO standard{};
  check(GetFileInformationByHandleEx(handle,FileAttributeTagInfo,&attributes,sizeof(attributes))&&GetFileInformationByHandleEx(handle,FileStandardInfo,&standard,sizeof(standard)));
  check(!(attributes.FileAttributes&FILE_ATTRIBUTE_REPARSE_POINT),"REPARSE_POINT");check(!standard.DeletePending&&static_cast<bool>(standard.Directory)==directory,"FILE_TYPE");
  if(!directory){check(standard.NumberOfLinks==1,"HARD_LINK");check(standard.EndOfFile.QuadPart>=0&&static_cast<uint64_t>(standard.EndOfFile.QuadPart)<=maxBytes,"SIZE_LIMIT");}
  wchar_t fs[32];DWORD flags;check(GetVolumeInformationByHandleW(handle,nullptr,0,nullptr,nullptr,&flags,fs,32)&&equal(fs,L"NTFS")&&(flags&FILE_PERSISTENT_ACLS),"UNSUPPORTED_FILESYSTEM");
  DWORD count=GetFinalPathNameByHandleW(handle,nullptr,0,FILE_NAME_NORMALIZED|VOLUME_NAME_DOS);check(count>0&&count<32768,"UNSAFE_ALIAS");std::vector<wchar_t> actual(count+1);check(GetFinalPathNameByHandleW(handle,actual.data(),static_cast<DWORD>(actual.size()),FILE_NAME_NORMALIZED|VOLUME_NAME_DOS)>0,"UNSAFE_ALIAS");
  check(equal(actual.data(),L"\\\\?\\"+expected),"UNSAFE_ALIAS");acl(handle,user,privateObject,protectedRoot);identify(handle);
}
struct Tree {std::vector<Handle> handles;bool missing=false;HANDLE leaf()const{return handles.back().value;}};
Tree walk(const Path& path,const User& user,const Path* root,bool directory,bool create,bool allowMissing,DWORD access,uint64_t maxBytes,bool privateRoot=true){
  size_t rootCount=root?root->components.size():SIZE_MAX;
  if(root)check(path.value.size()>=root->value.size()&&equal(path.value.substr(0,root->value.size()),root->value)&&(path.value.size()==root->value.size()||path.value[root->value.size()]==L'\\'),"INVALID_PATH");
  Tree tree,declaredRoot;Identity rootIdentity;bool compareRoot=false;
  // NTFS can enable case sensitivity per directory. An ordinal-ignore-case
  // prefix alone must not authorize a different root whose name differs only
  // in case. Verify the declared spelling against the full native identity.
  if(root&&path.value.substr(0,root->value.size())!=root->value){
    declaredRoot=walk(*root,user,root,true,false,allowMissing,0,std::numeric_limits<uint64_t>::max(),privateRoot);
    if(declaredRoot.missing){tree.missing=true;return tree;}
    rootIdentity=identify(declaredRoot.leaf());compareRoot=true;
  }
  Security security(user);
  for(size_t index=0;index<=path.components.size();index++){
    auto current=joinPrefix(path,index);bool leaf=index==path.components.size(),isDirectory=!leaf||directory;
    // Denying FILE_SHARE_DELETE pins every traversed component through the
    // entire operation. No pathname component can be renamed under this walk.
    // Attribute-only opens do not participate in Windows sharing checks.
    // A real read/list access makes omission of FILE_SHARE_DELETE effective.
    DWORD desired=READ_CONTROL|FILE_READ_ATTRIBUTES|(isDirectory?FILE_LIST_DIRECTORY:FILE_READ_DATA)|(leaf?access:0);
    Handle handle(CreateFileW(current.c_str(),desired,FILE_SHARE_READ|FILE_SHARE_WRITE,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
    if(handle.value==INVALID_HANDLE_VALUE){
      DWORD error=GetLastError();if(error!=ERROR_FILE_NOT_FOUND&&error!=ERROR_PATH_NOT_FOUND)reject("IO_ERROR");
      if(create&&isDirectory){check(CreateDirectoryW(current.c_str(),&security.attributes)||GetLastError()==ERROR_ALREADY_EXISTS);handle=Handle(CreateFileW(current.c_str(),desired,FILE_SHARE_READ|FILE_SHARE_WRITE,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr));check(handle.value!=INVALID_HANDLE_VALUE);}
      else {if(allowMissing){tree.missing=true;return tree;}reject("MISSING");}
    }
    bool privateObject=privateRoot&&root&&index>=rootCount;validate(handle.value,current,user,isDirectory,privateObject,privateRoot&&root&&index==rootCount,maxBytes);
    if(compareRoot&&index==rootCount){auto identity=identify(handle.value);check(identity.volume==rootIdentity.volume&&identity.fileId==rootIdentity.fileId,"INVALID_PATH");}
    tree.handles.push_back(std::move(handle));
  }
  return tree;
}
struct Options {Path path;Path root;bool hasRoot;bool directory,create,allowMissing,replace;uint64_t maxBytes;};
Options options(napi_env env,napi_value pathname,napi_value object){
  auto path=canonical(text(env,pathname));bool hasRoot=has(env,object,"root");Path root=hasRoot?canonical(text(env,property(env,object,"root"))):path;
  auto kind=text(env,property(env,object,"kind"));check(kind==L"file"||kind==L"directory");return {path,root,true,kind==L"directory",boolean(env,object,"create"),boolean(env,object,"allowMissing"),boolean(env,object,"replace",true),maximum(env,object)};
}
std::wstring randomName(const std::wstring& prefix){BYTE bytes[16];check(BCryptGenRandom(nullptr,bytes,sizeof(bytes),BCRYPT_USE_SYSTEM_PREFERRED_RNG)==0);auto encoded=hex(bytes,16);return prefix+std::wstring(encoded.begin(),encoded.end());}
napi_value error(napi_env env,const char* reason){napi_value message,exception;const char* safe="Windows private storage operation failed; no unsafe repair was attempted.";napi_create_string_utf8(env,safe,NAPI_AUTO_LENGTH,&message);napi_create_error(env,nullptr,message,&exception);set(env,exception,"reason",stringValue(env,reason));set(env,exception,"code",stringValue(env,"STORAGE_PRIVATE_REQUIRED"));napi_throw(env,exception);return nullptr;}
template<class F> napi_value guarded(napi_env env,F work){try{return work();}catch(const Failure& failure){return error(env,failure.reason);}catch(...){return error(env,"IO_ERROR");}}
std::vector<napi_value> args(napi_env env,napi_callback_info info,size_t count){std::vector<napi_value> result(count);size_t actual=count;check(napi_get_cb_info(env,info,&actual,result.data(),nullptr,nullptr)==napi_ok&&actual==count);return result;}
napi_value assertAvailable(napi_env env,napi_callback_info){return guarded(env,[&]{User user;return undefined(env);});}
napi_value inspect(napi_env env,napi_callback_info info){return guarded(env,[&]{
  auto values=args(env,info,3);auto opt=options(env,values[0],values[1]);napi_valuetype callbackType;
  check(napi_typeof(env,values[2],&callbackType)==napi_ok&&callbackType==napi_function);
  User user;auto tree=walk(opt.path,user,&opt.root,opt.directory,opt.create,opt.allowMissing,0,opt.maxBytes);
  if(tree.missing)return nullValue(env);
  const auto identity=identify(tree.leaf());napi_value metadata;
  // Only the fixed Node wrapper supplies this callback. All ancestor/leaf
  // handles stay pinned without delete sharing throughout the real Node stat;
  // no CRT descriptor or raw Windows HANDLE crosses the Node-API boundary.
  if(napi_call_function(env,undefined(env),values[2],0,nullptr,&metadata)!=napi_ok){
    bool pending=false;napi_is_exception_pending(env,&pending);
    if(pending){napi_value ignored;napi_get_and_clear_last_exception(env,&ignored);}
    reject("IO_ERROR");
  }
  napi_valuetype metadataType;check(napi_typeof(env,metadata,&metadataType)==napi_ok&&metadataType==napi_object);
  for(size_t index=0;index<tree.handles.size();index++){
    const bool leaf=index+1==tree.handles.size();
    validate(tree.handles[index].value,joinPrefix(opt.path,index),user,!leaf||opt.directory,index>=opt.root.components.size(),index==opt.root.components.size(),opt.maxBytes);
  }
  const auto after=identify(tree.leaf());check(identity.volume==after.volume&&identity.fileId==after.fileId,"FILE_CHANGED");
  napi_value result;check(napi_create_object(env,&result)==napi_ok);set(env,result,"metadata",metadata);
  set(env,result,"volume",stringValue(env,identity.volume));set(env,result,"fileId",stringValue(env,identity.fileId));return result;
});}
napi_value read(napi_env env,napi_callback_info info){return guarded(env,[&]{auto values=args(env,info,2);auto opt=options(env,values[0],values[1]);check(!opt.directory&&opt.maxBytes<=64ULL*1024*1024,"SIZE_LIMIT");User user;auto tree=walk(opt.path,user,&opt.root,false,false,opt.allowMissing,GENERIC_READ,opt.maxBytes);if(tree.missing)return nullValue(env);FILE_STANDARD_INFO before,after;check(GetFileInformationByHandleEx(tree.leaf(),FileStandardInfo,&before,sizeof(before)));std::vector<BYTE> buffer(static_cast<size_t>(opt.maxBytes)+1);size_t offset=0;while(offset<buffer.size()){DWORD count=0;check(ReadFile(tree.leaf(),buffer.data()+offset,static_cast<DWORD>(buffer.size()-offset),&count,nullptr));if(!count)break;offset+=count;}check(offset<=opt.maxBytes,"SIZE_LIMIT");check(GetFileInformationByHandleEx(tree.leaf(),FileStandardInfo,&after,sizeof(after))&&before.EndOfFile.QuadPart==after.EndOfFile.QuadPart&&offset==static_cast<size_t>(after.EndOfFile.QuadPart),"FILE_CHANGED");validate(tree.leaf(),opt.path.value,user,false,true,false,opt.maxBytes);napi_value result;check(napi_create_buffer_copy(env,offset,buffer.data(),nullptr,&result)==napi_ok);return result;});}
napi_value write(napi_env env,napi_callback_info info){return guarded(env,[&]{auto values=args(env,info,3);auto opt=options(env,values[0],values[2]);check(!opt.directory&&opt.maxBytes<=64ULL*1024*1024,"SIZE_LIMIT");void* bytes=nullptr;size_t length=0;check(napi_get_buffer_info(env,values[1],&bytes,&length)==napi_ok&&length<=opt.maxBytes,"SIZE_LIMIT");User user;auto destination=walk(opt.path,user,&opt.root,false,false,true,0,opt.maxBytes);if(!destination.missing&&!opt.replace)reject("ALREADY_EXISTS");check(destination.handles.size()>0);if(!destination.missing)destination.handles.pop_back();
  auto parent=joinPrefix(opt.path,opt.path.components.size()-1),temporary=parent+L"\\"+randomName(L".mioon-")+L".tmp";Security security(user);Handle staged(CreateFileW(temporary.c_str(),GENERIC_WRITE|GENERIC_READ|READ_CONTROL|DELETE,FILE_SHARE_READ,&security.attributes,CREATE_NEW,FILE_ATTRIBUTE_NORMAL|FILE_FLAG_OPEN_REPARSE_POINT,nullptr));check(staged.value!=INVALID_HANDLE_VALUE);bool committed=false;
  try{validate(staged.value,temporary,user,false,true,true,opt.maxBytes);size_t offset=0;while(offset<length){DWORD written=0;check(WriteFile(staged.value,static_cast<BYTE*>(bytes)+offset,static_cast<DWORD>(length-offset),&written,nullptr)&&written>0);offset+=written;}check(FlushFileBuffers(staged.value));validate(staged.value,temporary,user,false,true,true,opt.maxBytes);
    auto filename=opt.path.value;std::vector<BYTE> renameBytes(sizeof(FILE_RENAME_INFO)+filename.size()*sizeof(wchar_t));auto rename=reinterpret_cast<FILE_RENAME_INFO*>(renameBytes.data());rename->ReplaceIfExists=opt.replace?TRUE:FALSE;rename->RootDirectory=nullptr;rename->FileNameLength=static_cast<DWORD>(filename.size()*sizeof(wchar_t));memcpy(rename->FileName,filename.data(),rename->FileNameLength);
    if(!SetFileInformationByHandle(staged.value,FileRenameInfo,rename,static_cast<DWORD>(renameBytes.size()))){if(GetLastError()==ERROR_ALREADY_EXISTS||GetLastError()==ERROR_FILE_EXISTS)reject("ALREADY_EXISTS");reject("IO_ERROR");}committed=true;
  }catch(...){if(!committed){FILE_DISPOSITION_INFO disposition{TRUE};SetFileInformationByHandle(staged.value,FileDispositionInfo,&disposition,sizeof(disposition));}throw;}
  return undefined(env);
});}
napi_value remove(napi_env env,napi_callback_info info){return guarded(env,[&]{auto values=args(env,info,2);auto opt=options(env,values[0],values[1]);check(!opt.directory);User user;auto tree=walk(opt.path,user,&opt.root,false,false,true,DELETE,opt.maxBytes);if(tree.missing)return undefined(env);FILE_DISPOSITION_INFO disposition{TRUE};check(SetFileInformationByHandle(tree.leaf(),FileDispositionInfo,&disposition,sizeof(disposition)));return undefined(env);});}
napi_value temporary(napi_env env,napi_callback_info info){return guarded(env,[&]{auto values=args(env,info,2);auto parent=canonical(text(env,values[0]));auto prefix=text(env,values[1]);check(prefix.size()<=80&&std::all_of(prefix.begin(),prefix.end(),[](wchar_t c){return (c>=L'a'&&c<=L'z')||(c>=L'A'&&c<=L'Z')||(c>=L'0'&&c<=L'9')||c==L'.'||c==L'-';}),"INVALID_PATH");User user;auto pinned=walk(parent,user,nullptr,true,false,false,0,0);auto target=canonical(parent.value+L"\\"+randomName(prefix));Security security(user);check(CreateDirectoryW(target.value.c_str(),&security.attributes));auto created=walk(target,user,&target,true,false,false,0,0);napi_value result;check(napi_create_string_utf16(env,reinterpret_cast<const char16_t*>(target.value.data()),target.value.size(),&result)==napi_ok);return result;});}
#include "managed-io.inc"
} // namespace
#endif

napi_value initialize(napi_env env,napi_value exports){
#ifdef _WIN32
  const napi_property_descriptor methods[]={
    {"assertAvailable",nullptr,assertAvailable,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"inspect",nullptr,inspect,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"read",nullptr,read,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"write",nullptr,write,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"remove",nullptr,remove,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"temporary",nullptr,temporary,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"openManagedFile",nullptr,openManagedFile,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"openManagedDirectory",nullptr,openManagedDirectory,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"createManagedDirectory",nullptr,createManagedDirectory,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"syncManagedDirectory",nullptr,syncManagedDirectory,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"renameManaged",nullptr,renameManaged,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"removeManaged",nullptr,removeManaged,nullptr,nullptr,nullptr,napi_default,nullptr}
  };
  napi_define_properties(env,exports,sizeof(methods)/sizeof(methods[0]),methods);napi_value version;napi_create_int32(env,1,&version);napi_set_named_property(env,exports,"apiVersion",version);
#else
  napi_throw_error(env,"STORAGE_PRIVACY_UNAVAILABLE","The Windows private storage helper cannot initialize on this platform.");
#endif
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME,initialize)
